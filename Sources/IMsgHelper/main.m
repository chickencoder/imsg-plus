//
//  main.m
//  IMsgHelper - Standalone helper for IMCore access (legacy)
//
//  Reads a JSON command from stdin, executes it via IMCore, writes JSON to stdout.
//  The injectable dylib (IMsgInjected.m) is the primary mechanism; this is a fallback.
//

#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <dlfcn.h>

@interface IMChatRegistry : NSObject
+ (instancetype)sharedInstance;
- (id)existingChatWithChatIdentifier:(NSString *)identifier;
@end

@interface IMChat : NSObject
- (void)setLocalUserIsTyping:(BOOL)typing;
- (void)markAllMessagesAsRead;
@end

static NSDictionary* successResponse(NSDictionary *data) {
    NSMutableDictionary *response = [NSMutableDictionary dictionaryWithDictionary:data ?: @{}];
    response[@"success"] = @YES;
    response[@"timestamp"] = [[NSISO8601DateFormatter new] stringFromDate:[NSDate date]];
    return response;
}

static NSDictionary* errorResponse(NSString *error) {
    return @{
        @"success": @NO,
        @"error": error ?: @"Unknown error",
        @"timestamp": [[NSISO8601DateFormatter new] stringFromDate:[NSDate date]]
    };
}

static BOOL loadIMCore() {
    static BOOL loaded = NO, attempted = NO;
    if (attempted) return loaded;
    attempted = YES;
    loaded = dlopen("/System/Library/PrivateFrameworks/IMCore.framework/IMCore", RTLD_NOW) != NULL;
    return loaded;
}

static NSDictionary* handleTyping(NSDictionary *params) {
    NSString *handle = params[@"handle"];
    if (!handle) return errorResponse(@"Missing: handle");
    Class cls = NSClassFromString(@"IMChatRegistry");
    if (!cls) return errorResponse(@"IMChatRegistry not available");
    id chat = [[cls performSelector:@selector(sharedInstance)] existingChatWithChatIdentifier:handle];
    if (!chat) return errorResponse([NSString stringWithFormat:@"Chat not found: %@", handle]);
    @try {
        [chat setLocalUserIsTyping:[params[@"typing"] boolValue]];
        return successResponse(@{@"handle": handle, @"typing": params[@"typing"] ?: @NO});
    } @catch (NSException *e) {
        return errorResponse(e.reason);
    }
}

static NSDictionary* handleRead(NSDictionary *params) {
    NSString *handle = params[@"handle"];
    if (!handle) return errorResponse(@"Missing: handle");
    Class cls = NSClassFromString(@"IMChatRegistry");
    if (!cls) return errorResponse(@"IMChatRegistry not available");
    id chat = [[cls performSelector:@selector(sharedInstance)] existingChatWithChatIdentifier:handle];
    if (!chat) return errorResponse([NSString stringWithFormat:@"Chat not found: %@", handle]);
    @try {
        [chat markAllMessagesAsRead];
        return successResponse(@{@"handle": handle, @"marked_as_read": @YES});
    } @catch (NSException *e) {
        return errorResponse(e.reason);
    }
}

static NSDictionary* handleStatus(void) {
    BOOL loaded = loadIMCore();
    BOOL hasRegistry = NSClassFromString(@"IMChatRegistry") != nil;
    return successResponse(@{
        @"imcore_loaded": @(loaded),
        @"registry_available": @(hasRegistry),
        @"typing_available": @(hasRegistry),
        @"read_available": @(hasRegistry)
    });
}

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        if (!loadIMCore()) {
            NSData *d = [NSJSONSerialization dataWithJSONObject:errorResponse(@"Failed to load IMCore") options:0 error:nil];
            printf("%s\n", [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding].UTF8String);
            return 1;
        }
        NSData *input = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
        if (!input.length) {
            NSData *d = [NSJSONSerialization dataWithJSONObject:errorResponse(@"No input") options:0 error:nil];
            printf("%s\n", [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding].UTF8String);
            return 1;
        }
        NSDictionary *cmd = [NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
        if (![cmd isKindOfClass:[NSDictionary class]]) {
            NSData *d = [NSJSONSerialization dataWithJSONObject:errorResponse(@"Invalid JSON") options:0 error:nil];
            printf("%s\n", [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding].UTF8String);
            return 1;
        }
        NSString *action = cmd[@"action"];
        NSDictionary *params = cmd[@"params"] ?: @{};
        NSDictionary *response;
        if ([action isEqualToString:@"typing"])     response = handleTyping(params);
        else if ([action isEqualToString:@"read"])   response = handleRead(params);
        else if ([action isEqualToString:@"status"]) response = handleStatus();
        else response = errorResponse([NSString stringWithFormat:@"Unknown action: %@", action]);
        NSData *out = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
        printf("%s\n", [[NSString alloc] initWithData:out encoding:NSUTF8StringEncoding].UTF8String);
        return [response[@"success"] boolValue] ? 0 : 1;
    }
}
