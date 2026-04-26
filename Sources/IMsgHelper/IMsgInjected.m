//
//  IMsgInjected.m
//  IMsgHelper - Injectable dylib for Messages.app
//
//  Injected via DYLD_INSERT_LIBRARIES to access IMCore's chat registry.
//  Provides typing indicators and read receipts via file-based IPC.
//

#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <unistd.h>

@class IMMessage;

#pragma mark - IPC File Paths

static NSString *kCommandFile = nil;
static NSString *kResponseFile = nil;
static NSString *kLockFile = nil;
static NSTimer *fileWatchTimer = nil;
static int lockFd = -1;

static void initFilePaths(void) {
    if (kCommandFile == nil) {
        NSString *containerPath = NSHomeDirectory();
        kCommandFile = [containerPath stringByAppendingPathComponent:@".imsg-plus-command.json"];
        kResponseFile = [containerPath stringByAppendingPathComponent:@".imsg-plus-response.json"];
        kLockFile = [containerPath stringByAppendingPathComponent:@".imsg-plus-ready"];
    }
}

#pragma mark - IMCore Forward Declarations

@interface IMChatRegistry : NSObject
+ (instancetype)sharedInstance;
- (id)existingChatWithGUID:(NSString *)guid;
- (id)existingChatWithChatIdentifier:(NSString *)identifier;
- (NSArray *)allExistingChats;
@end

@interface IMChat : NSObject
- (void)setLocalUserIsTyping:(BOOL)typing;
- (void)markAllMessagesAsRead;
- (NSArray *)participants;
- (NSString *)guid;
- (NSString *)chatIdentifier;
@end

@interface IMHandle : NSObject
- (NSString *)ID;
@end

#pragma mark - Runtime Compatibility

static BOOL IMMessageItem_isEditedMessageHistory(id self, SEL _cmd) {
    return NO;
}

static void injectCompatibilityMethods(void) {
    SEL selector = @selector(isEditedMessageHistory);
    Class IMMessageItemClass = NSClassFromString(@"IMMessageItem");
    if (IMMessageItemClass && ![IMMessageItemClass instancesRespondToSelector:selector]) {
        class_addMethod(IMMessageItemClass, selector,
                       (IMP)IMMessageItem_isEditedMessageHistory, "c@:");
    }
    Class IMMessageClass = NSClassFromString(@"IMMessage");
    if (IMMessageClass && ![IMMessageClass instancesRespondToSelector:selector]) {
        class_addMethod(IMMessageClass, selector,
                       (IMP)IMMessageItem_isEditedMessageHistory, "c@:");
    }
}

#pragma mark - JSON Response Helpers

static NSDictionary* successResponse(NSInteger requestId, NSDictionary *data) {
    NSMutableDictionary *response = [NSMutableDictionary dictionaryWithDictionary:data ?: @{}];
    response[@"id"] = @(requestId);
    response[@"success"] = @YES;
    response[@"timestamp"] = [[NSISO8601DateFormatter new] stringFromDate:[NSDate date]];
    return response;
}

static NSDictionary* errorResponse(NSInteger requestId, NSString *error) {
    return @{
        @"id": @(requestId),
        @"success": @NO,
        @"error": error ?: @"Unknown error",
        @"timestamp": [[NSISO8601DateFormatter new] stringFromDate:[NSDate date]]
    };
}

#pragma mark - Chat Resolution

static id findChat(NSString *identifier) {
    Class registryClass = NSClassFromString(@"IMChatRegistry");
    if (!registryClass) return nil;

    id registry = [registryClass performSelector:@selector(sharedInstance)];
    if (!registry) return nil;

    id chat = nil;

    // Try existingChatWithGUID: for full GUIDs like "iMessage;-;email@example.com"
    SEL guidSel = @selector(existingChatWithGUID:);
    if ([registry respondsToSelector:guidSel]) {
        if ([identifier containsString:@";"]) {
            chat = [registry performSelector:guidSel withObject:identifier];
            if (chat) return chat;
        }
        NSArray *prefixes = @[@"iMessage;-;", @"iMessage;+;", @"SMS;-;", @"SMS;+;"];
        for (NSString *prefix in prefixes) {
            chat = [registry performSelector:guidSel
                                  withObject:[prefix stringByAppendingString:identifier]];
            if (chat) return chat;
        }
    }

    // Try existingChatWithChatIdentifier:
    SEL identSel = @selector(existingChatWithChatIdentifier:);
    if ([registry respondsToSelector:identSel]) {
        chat = [registry performSelector:identSel withObject:identifier];
        if (chat) return chat;
    }

    // Fall back to iterating all chats and matching by participant
    SEL allChatsSel = @selector(allExistingChats);
    if (![registry respondsToSelector:allChatsSel]) return nil;

    NSArray *allChats = [registry performSelector:allChatsSel];
    if (!allChats) return nil;

    // Normalize phone number for comparison
    NSString *normalizedIdentifier = nil;
    if ([identifier hasPrefix:@"+"] || [identifier hasPrefix:@"1"] ||
        [[NSCharacterSet decimalDigitCharacterSet] characterIsMember:[identifier characterAtIndex:0]]) {
        NSMutableString *digits = [NSMutableString string];
        for (NSUInteger i = 0; i < identifier.length; i++) {
            unichar c = [identifier characterAtIndex:i];
            if ([[NSCharacterSet decimalDigitCharacterSet] characterIsMember:c]) {
                [digits appendFormat:@"%C", c];
            }
        }
        normalizedIdentifier = [digits copy];
    }

    for (id aChat in allChats) {
        if ([aChat respondsToSelector:@selector(guid)]) {
            if ([[aChat performSelector:@selector(guid)] isEqualToString:identifier]) return aChat;
        }
        if ([aChat respondsToSelector:@selector(chatIdentifier)]) {
            if ([[aChat performSelector:@selector(chatIdentifier)] isEqualToString:identifier]) return aChat;
        }
        if ([aChat respondsToSelector:@selector(participants)]) {
            NSArray *participants = [aChat performSelector:@selector(participants)];
            for (id handle in participants ?: @[]) {
                if (![handle respondsToSelector:@selector(ID)]) continue;
                NSString *handleID = [handle performSelector:@selector(ID)];
                if ([handleID isEqualToString:identifier]) return aChat;
                if (normalizedIdentifier && normalizedIdentifier.length >= 10) {
                    NSMutableString *handleDigits = [NSMutableString string];
                    for (NSUInteger i = 0; i < handleID.length; i++) {
                        unichar c = [handleID characterAtIndex:i];
                        if ([[NSCharacterSet decimalDigitCharacterSet] characterIsMember:c]) {
                            [handleDigits appendFormat:@"%C", c];
                        }
                    }
                    if (handleDigits.length >= 10 &&
                        ([handleDigits hasSuffix:normalizedIdentifier] ||
                         [normalizedIdentifier hasSuffix:handleDigits])) {
                        return aChat;
                    }
                }
            }
        }
    }

    NSLog(@"[imsg-plus] Chat not found for: %@", identifier);
    return nil;
}

#pragma mark - Command Handlers

static NSDictionary* handleTyping(NSInteger requestId, NSDictionary *params) {
    NSString *handle = params[@"handle"];
    if (!handle) return errorResponse(requestId, @"Missing required parameter: handle");

    BOOL typing = [params[@"typing"] ?: params[@"state"] boolValue];
    id chat = findChat(handle);
    if (!chat) return errorResponse(requestId, [NSString stringWithFormat:@"Chat not found: %@", handle]);

    @try {
        SEL typingSel = @selector(setLocalUserIsTyping:);
        if (![chat respondsToSelector:typingSel]) {
            return errorResponse(requestId, @"setLocalUserIsTyping: not available");
        }
        NSMethodSignature *sig = [chat methodSignatureForSelector:typingSel];
        NSInvocation *inv = [NSInvocation invocationWithMethodSignature:sig];
        [inv setSelector:typingSel];
        [inv setTarget:chat];
        [inv setArgument:&typing atIndex:2];
        [inv invoke];
        return successResponse(requestId, @{@"handle": handle, @"typing": @(typing)});
    } @catch (NSException *exception) {
        return errorResponse(requestId, [NSString stringWithFormat:@"Failed: %@", exception.reason]);
    }
}

static NSDictionary* handleRead(NSInteger requestId, NSDictionary *params) {
    NSString *handle = params[@"handle"];
    if (!handle) return errorResponse(requestId, @"Missing required parameter: handle");

    id chat = findChat(handle);
    if (!chat) return errorResponse(requestId, [NSString stringWithFormat:@"Chat not found: %@", handle]);

    @try {
        SEL readSel = @selector(markAllMessagesAsRead);
        if (![chat respondsToSelector:readSel]) {
            return errorResponse(requestId, @"markAllMessagesAsRead not available");
        }
        [chat performSelector:readSel];
        return successResponse(requestId, @{@"handle": handle, @"marked_as_read": @YES});
    } @catch (NSException *exception) {
        return errorResponse(requestId, [NSString stringWithFormat:@"Failed: %@", exception.reason]);
    }
}

#pragma mark - Voice-Note Send
//
// handleSendVoiceNote
// ===================
// Mirrors BlueBubblesHelper's send-attachment + isAudioMessage path 1:1.
// BlueBubbles has shipped this flow successfully for years; reproducing it
// exactly is faster than re-deriving it. The two load-bearing pieces are:
//
//   1. The persistent-path dance via
//      `_persistentPathForTransfer:filename:highQuality:chatGUID:storeAtExternalPath:`.
//      With `chatGUID:nil, storeAtExternalPath:TRUE`, the returned path is
//      *outside* the Messages.app sandbox container — under
//      `~/Library/Messages/Attachments/...` — which is where imagent expects
//      to find it. We copy the staged audio there, retarget the transfer,
//      then `registerTransferWithDaemon:`.
//
//   2. An attributed body with the U+FFFC (Object Replacement Character)
//      carrying *four* attributes — exactly what BlueBubbles uses for any
//      attachment send. The bare transfer GUID is the value of
//      `__kIMFileTransferGUIDAttributeName` (NOT the `at_0_<guid>` form
//      observed in *received* attributedBody dumps; that prefix is a
//      position-encoded display value generated on receive).
//
//      Required attrs (BlueBubbles bbhelper.m:467):
//        __kIMBaseWritingDirectionAttributeName = @"-1"
//        __kIMFileTransferGUIDAttributeName     = transferGUID
//        __kIMFilenameAttributeName             = "Audio Message.caf"
//        __kIMMessagePartAttributeName          = @0
//
// IMMessage construction uses the long init ending in
// balloonBundleID:payloadData:expressiveSendStyleID:, with flags
//   0x100005 | 0x200000 = 0x300005   (file + audio-message bit).
// Then `[chat sendMessage:]`.
//
// FORMAT — TS side transcodes input to CAF/Opus mono 24 kHz before reaching
// this handler. Apple's own voice notes use that exact codec; PCM in CAF
// delivers but renders as an empty bubble on the receiver.

static NSDictionary* handleSendVoiceNote(NSInteger requestId, NSDictionary *params) {
    NSString *handle = params[@"handle"];
    NSString *audioPath = params[@"audio_path"];

    if (!handle || !audioPath) {
        return errorResponse(requestId, @"Missing required parameters: handle, audio_path");
    }

    if (![[NSFileManager defaultManager] fileExistsAtPath:audioPath]) {
        return errorResponse(requestId,
            [NSString stringWithFormat:@"Audio file not found: %@", audioPath]);
    }

    id chat = findChat(handle);
    if (!chat) {
        return errorResponse(requestId,
            [NSString stringWithFormat:@"Chat not found: %@", handle]);
    }

    Class IMMessageClass = NSClassFromString(@"IMMessage");
    Class IMFileTransferCenterClass = NSClassFromString(@"IMFileTransferCenter");
    Class IMDPersistentAttachmentControllerClass =
        NSClassFromString(@"IMDPersistentAttachmentController");
    if (!IMMessageClass || !IMFileTransferCenterClass || !IMDPersistentAttachmentControllerClass) {
        return errorResponse(requestId,
            @"Missing IMCore class (IMMessage / IMFileTransferCenter / IMDPersistentAttachmentController)");
    }

    @try {
        // --- 1. Register a new outgoing transfer GUID for the local file ---
        id transferCenter = [IMFileTransferCenterClass performSelector:@selector(sharedInstance)];
        if (!transferCenter) {
            return errorResponse(requestId, @"IMFileTransferCenter sharedInstance unavailable");
        }

        NSURL *originalURL = [NSURL fileURLWithPath:audioPath];
        NSString *filename = [originalURL lastPathComponent]; // "Audio Message.caf"

        SEL guidForNewSel = @selector(guidForNewOutgoingTransferWithLocalURL:);
        if (![transferCenter respondsToSelector:guidForNewSel]) {
            return errorResponse(requestId,
                @"IMFileTransferCenter missing guidForNewOutgoingTransferWithLocalURL:");
        }
        NSString *transferGUID = ((id (*)(id, SEL, id))objc_msgSend)(
            transferCenter, guidForNewSel, originalURL);
        if (!transferGUID) {
            return errorResponse(requestId, @"Failed to register outgoing file transfer");
        }

        SEL transferForGuidSel = @selector(transferForGUID:);
        id transfer = nil;
        if ([transferCenter respondsToSelector:transferForGuidSel]) {
            transfer = [transferCenter performSelector:transferForGuidSel withObject:transferGUID];
        }
        if (!transfer) {
            return errorResponse(requestId, @"transferForGUID: returned nil");
        }

        // --- 2. Persistent-path dance (BlueBubbles bbhelper.m:921-957) ---
        id persistCtrl = [IMDPersistentAttachmentControllerClass
                          performSelector:@selector(sharedInstance)];
        SEL persistSel = @selector(_persistentPathForTransfer:filename:highQuality:chatGUID:storeAtExternalPath:);
        if (persistCtrl && [persistCtrl respondsToSelector:persistSel]) {
            typedef NSString * (*PersistFn)(id, SEL, id, NSString *, BOOL, NSString *, BOOL);
            PersistFn persistFn = (PersistFn)objc_msgSend;
            // chatGUID:nil, storeAtExternalPath:YES — places the path under
            // ~/Library/Messages/Attachments/... (outside sandbox container)
            NSString *persistentPath = persistFn(persistCtrl, persistSel,
                                                  transfer, filename, YES, nil, YES);
            if (persistentPath) {
                NSURL *persistentURL = [NSURL fileURLWithPath:persistentPath];
                NSError *folderErr = nil;
                [[NSFileManager defaultManager]
                    createDirectoryAtURL:[persistentURL URLByDeletingLastPathComponent]
                    withIntermediateDirectories:YES attributes:nil error:&folderErr];
                if (folderErr) {
                    NSLog(@"[imsg-plus] persistent-path mkdir failed: %@", folderErr);
                }

                if (![[NSFileManager defaultManager] fileExistsAtPath:persistentPath]) {
                    NSError *copyErr = nil;
                    [[NSFileManager defaultManager] copyItemAtURL:originalURL
                                                            toURL:persistentURL
                                                            error:&copyErr];
                    if (copyErr) {
                        NSLog(@"[imsg-plus] persistent-path copy failed: %@", copyErr);
                    }
                }

                SEL retargetSel = @selector(retargetTransfer:toPath:);
                if ([transferCenter respondsToSelector:retargetSel]) {
                    typedef void (*RetargetFn)(id, SEL, id, NSString *);
                    RetargetFn retargetFn = (RetargetFn)objc_msgSend;
                    retargetFn(transferCenter, retargetSel, transferGUID, persistentPath);
                }

                SEL setLocalURLSel = @selector(setLocalURL:);
                if ([transfer respondsToSelector:setLocalURLSel]) {
                    [transfer performSelector:setLocalURLSel withObject:persistentURL];
                }
            } else {
                NSLog(@"[imsg-plus] _persistentPathForTransfer: returned nil — falling back to original URL");
            }
        }

        // --- 3. Register transfer with the daemon ---
        SEL registerSel = @selector(registerTransferWithDaemon:);
        if ([transferCenter respondsToSelector:registerSel]) {
            [transferCenter performSelector:registerSel withObject:transferGUID];
        }

        // --- 4. Build the attributed body (4 attrs, bare transfer GUID) ---
        NSDictionary *attrs = @{
            @"__kIMBaseWritingDirectionAttributeName": @"-1",
            @"__kIMFileTransferGUIDAttributeName": transferGUID,
            @"__kIMFilenameAttributeName": filename,
            @"__kIMMessagePartAttributeName": @0,
        };
        NSAttributedString *attributedBody =
            [[NSAttributedString alloc] initWithString:@"￼" attributes:attrs];

        // --- 5. Construct IMMessage with audio flag ---
        unsigned long long flags = 0x300005ULL; // 0x100005 (file) | 0x200000 (audio)
        SEL bbInit = @selector(initWithSender:time:text:messageSubject:fileTransferGUIDs:flags:error:guid:subject:balloonBundleID:payloadData:expressiveSendStyleID:);
        id message = [IMMessageClass alloc];
        if (![message respondsToSelector:bbInit]) {
            return errorResponse(requestId,
                @"IMMessage missing the BlueBubbles long-init selector — macOS may need a different signature");
        }
        typedef id (*BBInitFn)(id, SEL,
            id, id, id, id, id,
            unsigned long long, id,
            id, id,
            id, id, id);
        BBInitFn bbInitFn = (BBInitFn)objc_msgSend;
        message = bbInitFn(message, bbInit,
            nil, nil, attributedBody, nil, @[transferGUID],
            flags, nil,
            nil, nil,
            nil, nil, nil);

        if (!message) {
            return errorResponse(requestId, @"Failed to construct IMMessage");
        }

        // --- 6. Send via IMChat sendMessage: ---
        SEL sendSel = @selector(sendMessage:);
        if (![chat respondsToSelector:sendSel]) {
            return errorResponse(requestId, @"Chat does not respond to sendMessage:");
        }
        [chat performSelector:sendSel withObject:message];

        return successResponse(requestId, @{
            @"handle": handle,
            @"audio_path": audioPath,
            @"transfer_guid": transferGUID,
        });
    } @catch (NSException *exception) {
        NSLog(@"[imsg-plus] ❌ Exception in send_voice_note: %@\n%@",
              exception.reason, exception.callStackSymbols);
        return errorResponse(requestId,
            [NSString stringWithFormat:@"send_voice_note failed: %@", exception.reason]);
    }
}

static NSDictionary* handleStatus(NSInteger requestId) {
    Class registryClass = NSClassFromString(@"IMChatRegistry");
    BOOL hasRegistry = (registryClass != nil);
    NSUInteger chatCount = 0;
    if (hasRegistry) {
        id registry = [registryClass performSelector:@selector(sharedInstance)];
        if ([registry respondsToSelector:@selector(allExistingChats)]) {
            chatCount = [[registry performSelector:@selector(allExistingChats)] count];
        }
    }
    return successResponse(requestId, @{
        @"injected": @YES,
        @"registry_available": @(hasRegistry),
        @"chat_count": @(chatCount),
        @"typing_available": @(hasRegistry),
        @"read_available": @(hasRegistry)
    });
}

#pragma mark - Command Router

static NSDictionary* processCommand(NSDictionary *command) {
    NSInteger requestId = [command[@"id"] integerValue];
    NSString *action = command[@"action"];
    NSDictionary *params = command[@"params"] ?: @{};

    NSLog(@"[imsg-plus] Processing: %@ (id=%ld)", action, (long)requestId);

    if ([action isEqualToString:@"typing"])             return handleTyping(requestId, params);
    if ([action isEqualToString:@"read"])               return handleRead(requestId, params);
    if ([action isEqualToString:@"send_voice_note"])    return handleSendVoiceNote(requestId, params);
    if ([action isEqualToString:@"status"])             return handleStatus(requestId);
    if ([action isEqualToString:@"ping"])               return successResponse(requestId, @{@"pong": @YES});

    return errorResponse(requestId, [NSString stringWithFormat:@"Unknown action: %@", action]);
}

#pragma mark - File-Based IPC

static void processCommandFile(void) {
    @autoreleasepool {
        initFilePaths();

        NSData *commandData = [NSData dataWithContentsOfFile:kCommandFile];
        if (!commandData || commandData.length <= 2) return;

        NSError *error = nil;
        NSDictionary *command = [NSJSONSerialization JSONObjectWithData:commandData options:0 error:&error];
        if (error || ![command isKindOfClass:[NSDictionary class]]) {
            NSData *responseData = [NSJSONSerialization dataWithJSONObject:errorResponse(0, @"Invalid JSON")
                                                                  options:0 error:nil];
            [responseData writeToFile:kResponseFile atomically:YES];
            [@"" writeToFile:kCommandFile atomically:YES encoding:NSUTF8StringEncoding error:nil];
            return;
        }

        NSDictionary *result = processCommand(command);
        NSData *responseData = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
        [responseData writeToFile:kResponseFile atomically:YES];
        [@"" writeToFile:kCommandFile atomically:YES encoding:NSUTF8StringEncoding error:nil];
    }
}

static void startFileWatcher(void) {
    initFilePaths();
    NSLog(@"[imsg-plus] Starting file-based IPC: %@", kCommandFile);

    [@"" writeToFile:kCommandFile atomically:YES encoding:NSUTF8StringEncoding error:nil];
    [@"" writeToFile:kResponseFile atomically:YES encoding:NSUTF8StringEncoding error:nil];

    lockFd = open(kLockFile.UTF8String, O_CREAT | O_WRONLY, 0644);
    if (lockFd >= 0) {
        NSString *pidStr = [NSString stringWithFormat:@"%d", getpid()];
        write(lockFd, pidStr.UTF8String, pidStr.length);
    }

    __block NSDate *lastModified = nil;
    NSTimer *timer = [NSTimer timerWithTimeInterval:0.1 repeats:YES block:^(NSTimer *t) {
        @autoreleasepool {
            NSDictionary *attrs = [[NSFileManager defaultManager] attributesOfItemAtPath:kCommandFile error:nil];
            NSDate *modDate = attrs[NSFileModificationDate];
            if (modDate && ![modDate isEqualToDate:lastModified]) {
                NSData *data = [NSData dataWithContentsOfFile:kCommandFile];
                if (data && data.length > 2) {
                    lastModified = modDate;
                    processCommandFile();
                }
            }
        }
    }];
    [[NSRunLoop mainRunLoop] addTimer:timer forMode:NSRunLoopCommonModes];
    fileWatchTimer = timer;

    NSLog(@"[imsg-plus] Ready for commands");
}

#pragma mark - Dylib Entry Point

__attribute__((constructor))
static void injectedInit(void) {
    NSLog(@"[imsg-plus] Dylib injected into %@", [[NSProcessInfo processInfo] processName]);
    injectCompatibilityMethods();

    Class daemonClass = NSClassFromString(@"IMDaemonController");
    if (daemonClass) {
        id daemon = [daemonClass performSelector:@selector(sharedInstance)];
        if (daemon && [daemon respondsToSelector:@selector(connectToDaemon)]) {
            [daemon performSelector:@selector(connectToDaemon)];
            NSLog(@"[imsg-plus] Connected to IMDaemon");
        }
    }

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        Class registryClass = NSClassFromString(@"IMChatRegistry");
        if (registryClass) {
            id registry = [registryClass performSelector:@selector(sharedInstance)];
            if ([registry respondsToSelector:@selector(allExistingChats)]) {
                NSLog(@"[imsg-plus] IMChatRegistry: %lu chats",
                      (unsigned long)[[registry performSelector:@selector(allExistingChats)] count]);
            }
        }
        startFileWatcher();
    });
}

__attribute__((destructor))
static void injectedCleanup(void) {
    if (fileWatchTimer) { [fileWatchTimer invalidate]; fileWatchTimer = nil; }
    if (lockFd >= 0) { close(lockFd); lockFd = -1; }
    initFilePaths();
    [[NSFileManager defaultManager] removeItemAtPath:kLockFile error:nil];
}
