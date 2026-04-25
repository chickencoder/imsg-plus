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

#pragma mark - Contact-Card Send
//
// handleSendContactCard
// =====================
// Sends a .vcf as a rich contact balloon (avatar + name + chevron pill) instead
// of a generic file attachment. The receiver renders this via Messages.app's
// `com.apple.messages.contact-card-extension` balloon plugin, which is only
// triggered when the outgoing IMMessage carries a non-nil `balloonBundleID`
// + `payloadData`. AppleScript can't set those, so we have to construct the
// IMMessage in-process via IMCore and dispatch via [chat sendMessage:].
//
// SCHEMA NOTE — payload_data plist is not officially documented.
// The schema in buildContactCardPayload below is a best-effort structure.
// Before relying on this in production, verify against a captured ground-truth
// message by sending a contact via Contacts.app's Share Contact, then:
//   sqlite3 ~/Library/Messages/chat.db \
//     "SELECT balloon_bundle_id, hex(payload_data) FROM message
//        WHERE balloon_bundle_id LIKE '%contact%' ORDER BY ROWID DESC LIMIT 1"
//   # then: xxd -r -p > /tmp/p.bin && plutil -convert xml1 /tmp/p.bin -o -
// If the captured plist differs, update buildContactCardPayload accordingly.

static NSData* buildContactCardPayload(NSString *filename, NSData *vcardData) {
    NSDictionary *plist = @{
        @"bid": @"com.apple.messages.contact-card-extension",
        @"filename": filename ?: @"contact.vcf",
        @"vcard": vcardData,
    };
    NSError *error = nil;
    NSData *data = [NSPropertyListSerialization
        dataWithPropertyList:plist
                      format:NSPropertyListBinaryFormat_v1_0
                     options:0
                       error:&error];
    if (error) {
        NSLog(@"[imsg-plus] Failed to serialize contact-card payload: %@", error);
        return nil;
    }
    return data;
}

static NSDictionary* handleSendContactCard(NSInteger requestId, NSDictionary *params) {
    NSString *handle = params[@"handle"];
    NSString *vcardB64 = params[@"vcard_b64"];
    NSString *filename = params[@"filename"] ?: @"contact.vcf";

    if (!handle || !vcardB64) {
        return errorResponse(requestId, @"Missing required parameters: handle, vcard_b64");
    }

    NSData *vcardData = [[NSData alloc] initWithBase64EncodedString:vcardB64 options:0];
    if (!vcardData || vcardData.length == 0) {
        return errorResponse(requestId, @"vcard_b64 is empty or not valid base64");
    }

    id chat = findChat(handle);
    if (!chat) {
        return errorResponse(requestId,
            [NSString stringWithFormat:@"Chat not found: %@", handle]);
    }

    NSData *payloadData = buildContactCardPayload(filename, vcardData);
    if (!payloadData) {
        return errorResponse(requestId, @"Failed to build contact-card payload plist");
    }

    Class IMMessageClass = NSClassFromString(@"IMMessage");
    if (!IMMessageClass) {
        return errorResponse(requestId, @"IMMessage class not found");
    }

    @try {
        id message = [IMMessageClass alloc];
        NSAttributedString *fallbackText =
            [[NSAttributedString alloc] initWithString:@"Contact"];

        // Construct via the long associated-message init (same shape used by
        // tapbacks in the BlueBubbles approach) and apply balloon-plugin
        // metadata via KVC. The balloon-aware init signature varies across
        // macOS versions; KVC is more robust.
        SEL longInit = @selector(initWithSender:time:text:messageSubject:fileTransferGUIDs:flags:error:guid:subject:associatedMessageGUID:associatedMessageType:associatedMessageRange:messageSummaryInfo:);
        if ([message respondsToSelector:longInit]) {
            typedef id (*InitFn)(id, SEL,
                id, id, id, id, id,
                unsigned long long, id,
                id, id, id,
                long long, NSRange, id);
            InitFn fn = (InitFn)objc_msgSend;
            message = fn(message, longInit,
                nil, nil, fallbackText, nil, nil,
                (unsigned long long)0x5, nil,
                nil, nil, nil,
                0, NSMakeRange(0, 0), nil);
        } else {
            message = [message init];
        }

        if (!message) {
            return errorResponse(requestId, @"Failed to construct IMMessage");
        }

        NSString *bundleID = @"com.apple.messages.contact-card-extension";
        @try { [message setValue:bundleID forKey:@"balloonBundleID"]; }
        @catch (NSException *e) { NSLog(@"[imsg-plus] setValue balloonBundleID failed: %@", e.reason); }
        @try { [message setValue:payloadData forKey:@"payloadData"]; }
        @catch (NSException *e) { NSLog(@"[imsg-plus] setValue payloadData failed: %@", e.reason); }

        SEL sendSel = @selector(sendMessage:);
        if (![chat respondsToSelector:sendSel]) {
            return errorResponse(requestId, @"Chat does not respond to sendMessage:");
        }
        [chat performSelector:sendSel withObject:message];

        return successResponse(requestId, @{
            @"handle": handle,
            @"filename": filename,
            @"bundle_id": bundleID,
            @"payload_bytes": @(payloadData.length),
            @"vcard_bytes": @(vcardData.length),
        });
    } @catch (NSException *exception) {
        NSLog(@"[imsg-plus] ❌ Exception in send_contact_card: %@\n%@",
              exception.reason, exception.callStackSymbols);
        return errorResponse(requestId,
            [NSString stringWithFormat:@"send_contact_card failed: %@", exception.reason]);
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
    if ([action isEqualToString:@"send_contact_card"])  return handleSendContactCard(requestId, params);
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
