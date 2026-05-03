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
#import <dlfcn.h>

@class IMMessage;

// IMCore C function — generates the proper threadIdentifier string for a
// reply by encoding the parent message part's range info. The naive
// `p:0/<guid>` form does NOT work: imagent silently strips the threading
// during send because it's not a properly-encoded identifier. BlueBubbles
// uses this function for the same purpose (see BlueBubblesHelper.m:1114).
typedef NSString * (*IMCreateThreadIdentifierFn)(id /* IMMessagePartChatItem */);

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

@interface IMChatHistoryController : NSObject
+ (instancetype)sharedInstance;
- (void)loadMessageWithGUID:(NSString *)guid completionBlock:(void (^)(id message))completion;
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

#pragma mark - Async Response Helper

// For handlers whose work completes outside the synchronous processCommand path
// (e.g. handleReact's IMChatHistoryController completion block). Writes the
// response and clears the command file the same way processCommandFile would.
static void writeResponseToFile(NSDictionary *response) {
    initFilePaths();
    NSData *responseData = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
    [responseData writeToFile:kResponseFile atomically:YES];
    [@"" writeToFile:kCommandFile atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

// Map a reaction code (2000–2005 added, 3000–3005 removed) to the verb prefix
// Messages.app uses in tapback summary text ("Loved …", "Liked …", etc.).
static NSString* reactionVerb(long long reactionType) {
    long long baseType = reactionType >= 3000 ? reactionType - 1000 : reactionType;
    switch (baseType) {
        case 2000: return @"Loved ";
        case 2001: return @"Liked ";
        case 2002: return @"Disliked ";
        case 2003: return @"Laughed at ";
        case 2004: return @"Emphasized ";
        case 2005: return @"Questioned ";
        default:   return @"Reacted to ";
    }
}

#pragma mark - Reactions

// Returns nil to signal async handling — the completion block writes the
// response via writeResponseToFile().
static NSDictionary* handleReact(NSInteger requestId, NSDictionary *params) {
    NSString *handle = params[@"handle"];
    NSString *messageGUID = params[@"guid"];
    NSNumber *type = params[@"type"];
    NSNumber *partIndexNum = params[@"partIndex"];
    int partIndex = partIndexNum ? [partIndexNum intValue] : 0;

    if (!handle || !messageGUID || !type) {
        return errorResponse(requestId, @"Missing required parameters: handle, guid, type");
    }

    id chat = findChat(handle);
    if (!chat) {
        return errorResponse(requestId, [NSString stringWithFormat:@"Chat not found: %@", handle]);
    }

    Class historyClass = NSClassFromString(@"IMChatHistoryController");
    if (!historyClass) {
        return errorResponse(requestId, @"IMChatHistoryController class not found");
    }

    id historyController = [historyClass performSelector:@selector(sharedInstance)];
    if (!historyController) {
        return errorResponse(requestId, @"Could not get IMChatHistoryController instance");
    }

    SEL loadSel = @selector(loadMessageWithGUID:completionBlock:);
    if (![historyController respondsToSelector:loadSel]) {
        return errorResponse(requestId, @"loadMessageWithGUID:completionBlock: not available");
    }

    NSLog(@"[imsg-plus] Loading message %@ via IMChatHistoryController (async)...", messageGUID);

    long long reactionType = [type longLongValue];

    NSMethodSignature *loadSig = [historyController methodSignatureForSelector:loadSel];
    if (!loadSig) {
        return errorResponse(requestId, @"Could not get method signature for loadMessageWithGUID:completionBlock:");
    }
    NSInvocation *loadInv = [NSInvocation invocationWithMethodSignature:loadSig];
    [loadInv setSelector:loadSel];
    [loadInv setTarget:historyController];
    [loadInv setArgument:&messageGUID atIndex:2];

    void (^completionBlock)(id) = ^(id message) {
        @autoreleasepool {
            NSLog(@"[imsg-plus] loadMessageWithGUID completion fired, message=%@, class=%@",
                  message, message ? NSStringFromClass([message class]) : @"nil");

            if (!message) {
                writeResponseToFile(errorResponse(requestId,
                    [NSString stringWithFormat:@"Message not found for GUID: %@", messageGUID]));
                return;
            }

            @try {
                id messageItem = [message valueForKey:@"_imMessageItem"];

                id items = nil;
                if (messageItem && [messageItem respondsToSelector:@selector(_newChatItems)]) {
                    items = [messageItem performSelector:@selector(_newChatItems)];
                } else if (messageItem) {
                    items = [messageItem valueForKey:@"_newChatItems"];
                }

                id partItem = nil;
                if ([items isKindOfClass:[NSArray class]]) {
                    NSArray *itemArray = (NSArray *)items;
                    for (id item in itemArray) {
                        NSString *className = NSStringFromClass([item class]);
                        if ([className containsString:@"MessagePartChatItem"] ||
                            [className containsString:@"TextMessagePartChatItem"]) {
                            if ([item respondsToSelector:@selector(index)]) {
                                NSInteger idx = ((NSInteger (*)(id, SEL))objc_msgSend)(item, @selector(index));
                                if (idx == partIndex) { partItem = item; break; }
                            } else if (partIndex == 0) {
                                partItem = item; break;
                            }
                        }
                    }
                    if (!partItem && itemArray.count > 0) {
                        partItem = itemArray[partIndex < (int)itemArray.count ? partIndex : 0];
                    }
                } else if (items) {
                    partItem = items;
                }

                NSAttributedString *itemText = nil;
                if (partItem && [partItem respondsToSelector:@selector(text)]) {
                    itemText = [partItem performSelector:@selector(text)];
                }
                if (!itemText && [message respondsToSelector:@selector(text)]) {
                    itemText = [message performSelector:@selector(text)];
                }
                NSString *summaryText = itemText ? itemText.string : @"";
                if (!summaryText) summaryText = @"";

                NSString *associatedGuid = [NSString stringWithFormat:@"p:%d/%@", partIndex, messageGUID];
                NSDictionary *messageSummary = @{@"amc": @1, @"ams": summaryText};

                NSString *verb = reactionVerb(reactionType);
                NSString *reactionString = [verb stringByAppendingString:
                    [NSString stringWithFormat:@"“%@”", summaryText]];
                NSMutableAttributedString *reactionText =
                    [[NSMutableAttributedString alloc] initWithString:reactionString];

                NSRange partRange = NSMakeRange(0, summaryText.length);
                if (partItem) {
                    SEL rangeSel = @selector(messagePartRange);
                    if ([partItem respondsToSelector:rangeSel]) {
                        NSMethodSignature *sig = [partItem methodSignatureForSelector:rangeSel];
                        NSInvocation *inv = [NSInvocation invocationWithMethodSignature:sig];
                        [inv setSelector:rangeSel];
                        [inv setTarget:partItem];
                        [inv invoke];
                        [inv getReturnValue:&partRange];
                    }
                }

                Class IMMessageClass = NSClassFromString(@"IMMessage");
                if (!IMMessageClass) {
                    writeResponseToFile(errorResponse(requestId, @"IMMessage class not found"));
                    return;
                }

                id reactionMessage = [IMMessageClass alloc];

                SEL initSel = @selector(initWithSender:time:text:messageSubject:fileTransferGUIDs:flags:error:guid:subject:associatedMessageGUID:associatedMessageType:associatedMessageRange:messageSummaryInfo:);

                if (![reactionMessage respondsToSelector:initSel]) {
                    writeResponseToFile(errorResponse(requestId,
                        @"IMMessage initWithSender:time:text:...associatedMessage... selector not found"));
                    return;
                }

                typedef id (*InitMsgSendType)(id, SEL,
                    id,                  // sender
                    id,                  // time
                    id,                  // text
                    id,                  // messageSubject
                    id,                  // fileTransferGUIDs
                    unsigned long long,  // flags
                    id,                  // error
                    id,                  // guid
                    id,                  // subject
                    id,                  // associatedMessageGUID
                    long long,           // associatedMessageType
                    NSRange,             // associatedMessageRange
                    id                   // messageSummaryInfo
                );

                InitMsgSendType initMsgSend = (InitMsgSendType)objc_msgSend;
                reactionMessage = initMsgSend(reactionMessage, initSel,
                    nil,                     // sender
                    nil,                     // time
                    reactionText,            // text
                    nil,                     // messageSubject
                    nil,                     // fileTransferGUIDs
                    (unsigned long long)0x5, // flags
                    nil,                     // error
                    nil,                     // guid
                    nil,                     // subject
                    associatedGuid,          // associatedMessageGUID
                    reactionType,            // associatedMessageType
                    partRange,               // associatedMessageRange
                    messageSummary           // messageSummaryInfo
                );

                if (!reactionMessage) {
                    writeResponseToFile(errorResponse(requestId, @"Failed to create reaction IMMessage (init returned nil)"));
                    return;
                }

                SEL sendSel = @selector(sendMessage:);
                if (![chat respondsToSelector:sendSel]) {
                    writeResponseToFile(errorResponse(requestId, @"Chat does not respond to sendMessage:"));
                    return;
                }

                [chat performSelector:sendSel withObject:reactionMessage];

                writeResponseToFile(successResponse(requestId, @{
                    @"handle": handle,
                    @"guid": messageGUID,
                    @"type": type,
                    @"partIndex": @(partIndex),
                    @"action": reactionType >= 3000 ? @"removed" : @"added"
                }));
            } @catch (NSException *exception) {
                NSLog(@"[imsg-plus] Exception in react completion: %@\n%@", exception.reason, exception.callStackSymbols);
                writeResponseToFile(errorResponse(requestId,
                    [NSString stringWithFormat:@"Failed in react completion: %@", exception.reason]));
            }
        }
    };

    [loadInv setArgument:&completionBlock atIndex:3];
    [loadInv invoke];

    // 5s safety net: if loadMessageWithGUID's completion never fires, write an
    // error so the caller doesn't hang.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        NSData *responseData = [NSData dataWithContentsOfFile:kResponseFile];
        if (!responseData || responseData.length < 3) {
            NSLog(@"[imsg-plus] React completion timeout after 5s for GUID: %@", messageGUID);
            writeResponseToFile(errorResponse(requestId,
                [NSString stringWithFormat:@"Timeout: message GUID not found or completion never fired: %@", messageGUID]));
        }
    });

    return nil; // async — completion block writes the response
}

#pragma mark - Threaded Reply
//
// Threaded replies (called "inline replies" in IMCore) require a properly
// encoded threadIdentifier. The naive `p:N/<parent-guid>` form is wrong —
// imagent silently strips the threading on send because the identifier
// isn't a valid encoding of the parent's message-part range. The correct
// identifier is generated by the IMCore C function
// `IMCreateThreadIdentifierForMessagePartChatItem(IMMessagePartChatItem *)`,
// which encodes <partIndex>:<rangeStart>:<rangeLength>/<guid> derived from
// the parent's chat item.
//
// Flow (mirrors BlueBubblesHelper.m:1039-1117):
//   1. Load parent IMMessage via IMChatHistoryController (async).
//   2. Walk the parent's _imMessageItem._newChatItems to find the
//      IMMessagePartChatItem at partIndex 0.
//   3. Call IMCreateThreadIdentifierForMessagePartChatItem(item) to get
//      the proper identifier.
//   4. Build a basic IMMessage via the BlueBubbles-style long init with
//      flags 0x100005, leaving threadIdentifier OUT of the init.
//   5. Set `messageToSend.threadIdentifier = identifier` via the property
//      after init. Do NOT set threadOriginator — BlueBubbles doesn't.
//   6. [chat sendMessage:].
//
// Async pattern, so this handler returns nil and the completion block
// writes the response via writeResponseToFile().

static NSDictionary* handleSendReply(NSInteger requestId, NSDictionary *params) {
    NSString *handle = params[@"handle"];
    NSString *text = params[@"text"];
    NSString *replyToGuid = params[@"reply_to_guid"];

    if (!handle || !text || !replyToGuid) {
        return errorResponse(requestId, @"Missing required parameters: handle, text, reply_to_guid");
    }
    if (text.length == 0) {
        return errorResponse(requestId, @"text must be non-empty");
    }

    id chat = findChat(handle);
    if (!chat) {
        return errorResponse(requestId, [NSString stringWithFormat:@"Chat not found: %@", handle]);
    }

    Class IMMessageClass = NSClassFromString(@"IMMessage");
    if (!IMMessageClass) {
        return errorResponse(requestId, @"IMMessage class not found");
    }

    Class historyClass = NSClassFromString(@"IMChatHistoryController");
    if (!historyClass) {
        return errorResponse(requestId, @"IMChatHistoryController class not found");
    }
    id historyController = [historyClass performSelector:@selector(sharedInstance)];
    if (!historyController) {
        return errorResponse(requestId, @"Could not get IMChatHistoryController instance");
    }
    SEL loadSel = @selector(loadMessageWithGUID:completionBlock:);
    if (![historyController respondsToSelector:loadSel]) {
        return errorResponse(requestId, @"loadMessageWithGUID:completionBlock: not available");
    }

    NSMethodSignature *loadSig = [historyController methodSignatureForSelector:loadSel];
    NSInvocation *loadInv = [NSInvocation invocationWithMethodSignature:loadSig];
    [loadInv setSelector:loadSel];
    [loadInv setTarget:historyController];
    [loadInv setArgument:&replyToGuid atIndex:2];

    void (^completionBlock)(id) = ^(id parentMessage) {
        @autoreleasepool {
            if (!parentMessage) {
                writeResponseToFile(errorResponse(requestId,
                    [NSString stringWithFormat:@"Reply-to message not found in local chat.db: %@", replyToGuid]));
                return;
            }

            @try {
                // Walk the parent's chat items to find the IMMessagePartChatItem
                // at partIndex 0 — same pattern handleReact uses.
                id messageItem = [parentMessage valueForKey:@"_imMessageItem"];
                id items = nil;
                if (messageItem && [messageItem respondsToSelector:@selector(_newChatItems)]) {
                    items = [messageItem performSelector:@selector(_newChatItems)];
                } else if (messageItem) {
                    items = [messageItem valueForKey:@"_newChatItems"];
                }
                id partItem = nil;
                if ([items isKindOfClass:[NSArray class]]) {
                    NSArray *itemArray = (NSArray *)items;
                    for (id item in itemArray) {
                        NSString *className = NSStringFromClass([item class]);
                        if ([className containsString:@"MessagePartChatItem"] ||
                            [className containsString:@"TextMessagePartChatItem"]) {
                            if ([item respondsToSelector:@selector(index)]) {
                                NSInteger idx = ((NSInteger (*)(id, SEL))objc_msgSend)(item, @selector(index));
                                if (idx == 0) { partItem = item; break; }
                            } else {
                                partItem = item; break;
                            }
                        }
                    }
                    if (!partItem && itemArray.count > 0) partItem = itemArray[0];
                } else if (items) {
                    partItem = items;
                }
                if (!partItem) {
                    writeResponseToFile(errorResponse(requestId,
                        @"Could not find IMMessagePartChatItem on parent message"));
                    return;
                }

                // Resolve IMCreateThreadIdentifierForMessagePartChatItem at runtime.
                // It's a C function exported from IMCore (the framework is already
                // loaded into Messages.app's process, so RTLD_DEFAULT finds it).
                IMCreateThreadIdentifierFn createThreadId =
                    (IMCreateThreadIdentifierFn)dlsym(RTLD_DEFAULT,
                        "IMCreateThreadIdentifierForMessagePartChatItem");
                if (!createThreadId) {
                    writeResponseToFile(errorResponse(requestId,
                        @"IMCreateThreadIdentifierForMessagePartChatItem unavailable in IMCore"));
                    return;
                }

                NSString *encodedThreadId = createThreadId(partItem);
                if (!encodedThreadId) {
                    writeResponseToFile(errorResponse(requestId,
                        @"IMCreateThreadIdentifierForMessagePartChatItem returned nil"));
                    return;
                }

                NSAttributedString *attributedBody = [[NSAttributedString alloc] initWithString:text];

                // BB-style long init, NO threadIdentifier in the init params.
                // Set threadIdentifier via the property setter post-init —
                // this is exactly what BlueBubbles does (BlueBubblesHelper.m:1006-1007).
                SEL bbInit = @selector(initWithSender:time:text:messageSubject:fileTransferGUIDs:flags:error:guid:subject:balloonBundleID:payloadData:expressiveSendStyleID:);
                id message = [IMMessageClass alloc];
                if (![message respondsToSelector:bbInit]) {
                    writeResponseToFile(errorResponse(requestId,
                        @"IMMessage missing the BlueBubbles long-init selector"));
                    return;
                }
                typedef id (*BBInitFn)(id, SEL,
                    id, id, id, id, id,
                    unsigned long long, id,
                    id, id,
                    id, id, id);
                BBInitFn bbInitFn = (BBInitFn)objc_msgSend;
                message = bbInitFn(message, bbInit,
                    nil, nil, attributedBody, nil, nil,
                    (unsigned long long)0x100005, nil,
                    nil, nil,
                    nil, nil, nil);

                if (!message) {
                    writeResponseToFile(errorResponse(requestId, @"Failed to construct reply IMMessage (init returned nil)"));
                    return;
                }

                SEL setThreadIdSel = @selector(setThreadIdentifier:);
                if ([message respondsToSelector:setThreadIdSel]) {
                    [message performSelector:setThreadIdSel withObject:encodedThreadId];
                }

                SEL sendSel = @selector(sendMessage:);
                if (![chat respondsToSelector:sendSel]) {
                    writeResponseToFile(errorResponse(requestId, @"Chat does not respond to sendMessage:"));
                    return;
                }
                [chat performSelector:sendSel withObject:message];

                writeResponseToFile(successResponse(requestId, @{
                    @"handle": handle,
                    @"reply_to_guid": replyToGuid,
                    @"thread_identifier": encodedThreadId,
                }));
            } @catch (NSException *exception) {
                NSLog(@"[imsg-plus] Exception in send_reply completion: %@\n%@",
                      exception.reason, exception.callStackSymbols);
                writeResponseToFile(errorResponse(requestId,
                    [NSString stringWithFormat:@"send_reply failed: %@", exception.reason]));
            }
        }
    };

    [loadInv setArgument:&completionBlock atIndex:3];
    [loadInv invoke];

    // Safety net: if the load completion never fires within 5s, write a
    // timeout response so the worker doesn't hang.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        NSData *responseData = [NSData dataWithContentsOfFile:kResponseFile];
        if (!responseData || responseData.length < 3) {
            writeResponseToFile(errorResponse(requestId,
                [NSString stringWithFormat:@"Timeout: parent message GUID not found or completion never fired: %@", replyToGuid]));
        }
    });

    return nil; // async — completion writes the response
}

#pragma mark - Command Router

static NSDictionary* processCommand(NSDictionary *command) {
    NSInteger requestId = [command[@"id"] integerValue];
    NSString *action = command[@"action"];
    NSDictionary *params = command[@"params"] ?: @{};

    NSLog(@"[imsg-plus] Processing: %@ (id=%ld)", action, (long)requestId);

    if ([action isEqualToString:@"typing"])             return handleTyping(requestId, params);
    if ([action isEqualToString:@"read"])               return handleRead(requestId, params);
    if ([action isEqualToString:@"react"])              return handleReact(requestId, params);
    if ([action isEqualToString:@"send_reply"])         return handleSendReply(requestId, params);
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
        if (!result) {
            // Async handler — it will writeResponseToFile() when done.
            return;
        }
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
