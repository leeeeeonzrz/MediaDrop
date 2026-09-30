// The inspector's transparent WebKit content is hosted INSIDE NSGlassEffectView.
// This lets AppKit sample the main content below it and render its own edge optics.
#import <WebKit/WebKit.h>

@interface MDInspectorWebView : WKWebView <NSDraggingSource>
@end
@implementation MDInspectorWebView
- (NSDragOperation)draggingSession:(NSDraggingSession *)session sourceOperationMaskForDraggingContext:(NSDraggingContext)context { return NSDragOperationCopy; }
@end

@class MDGlassInspector;
@interface MDGlassMessageProxy : NSObject <WKScriptMessageHandler>
@property(nonatomic, weak) MDGlassInspector *owner;
@end

API_AVAILABLE(macos(26.0))
@interface MDGlassInspector : NSObject <WKNavigationDelegate>
@property(nonatomic, strong) NSGlassEffectView *glass;
@property(nonatomic, strong) MDInspectorWebView *web;
@property(nonatomic, copy) NSString *pending;
@property(nonatomic) BOOL ready;
@property(nonatomic) BOOL presented;
@property(nonatomic) BOOL preparing;
@property(nonatomic) napi_threadsafe_function callback;
- (void)send:(NSDictionary *)message;
- (void)publish;
@end

@implementation MDGlassMessageProxy
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    if (message.frameInfo.isMainFrame && [message.body isKindOfClass:NSDictionary.class]) [self.owner send:message.body];
}
@end

@implementation MDGlassInspector
- (void)send:(NSDictionary *)message {
    if ([message[@"type"] isEqual:@"drag"] && self.pending) {
        NSDictionary *state = [NSJSONSerialization JSONObjectWithData:[self.pending dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
        NSString *file = state[@"dragFile"];
        NSEvent *event = NSApp.currentEvent;
        if ([message[@"revision"] isEqual:state[@"revision"]] && [file isKindOfClass:NSString.class] && [file hasPrefix:@"/"] && [NSFileManager.defaultManager isReadableFileAtPath:file] && event) {
            NSDraggingItem *item = [[NSDraggingItem alloc] initWithPasteboardWriter:[NSURL fileURLWithPath:file]];
            NSPoint point = [self.web convertPoint:event.locationInWindow fromView:nil];
            [item setDraggingFrame:NSMakeRect(point.x, point.y, 48, 48) contents:[NSWorkspace.sharedWorkspace iconForFile:file]];
            [self.web beginDraggingSessionWithItems:@[item] event:event source:self.web];
        }
        return;
    }
    if (!self.callback) return;
    NSData *data = [NSJSONSerialization dataWithJSONObject:message options:0 error:nil];
    if (!data || data.length > 65536) return;
    char *copy = strdup([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    if (napi_call_threadsafe_function(self.callback, copy, napi_tsfn_nonblocking) != napi_ok) free(copy);
}
- (void)publish {
    if (self.ready && self.pending) [self.web evaluateJavaScript:[@"window.renderInspector(" stringByAppendingFormat:@"%@)", self.pending] completionHandler:^(id value, NSError *error) {
        if (error) { self.glass.hidden = YES; [self send:@{@"type":@"unavailable"}]; }
        else if (!self.presented && !self.preparing) {
            // JS completion precedes WebKit's first compositor commit. Keep the
            // normal inspector visible until WebKit has produced a real frame.
            self.preparing = YES;
            [self.web takeSnapshotWithConfiguration:nil completionHandler:^(NSImage *image, NSError *snapshotError) {
                self.preparing = NO;
                if (image && !snapshotError) { self.presented = YES; [self send:@{@"type":@"ready"}]; }
                else { self.glass.hidden = YES; [self send:@{@"type":@"unavailable"}]; }
            }];
        }
    }];
}
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    self.ready = YES; [self publish];
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    self.glass.hidden = YES; [self send:@{@"type":@"unavailable"}];
}
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    // Only the initial local HTML document may load; media images are subresources.
    decisionHandler(action.navigationType == WKNavigationTypeOther && [action.request.URL.scheme isEqualToString:@"about"] ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}
- (void)dealloc {
    [self.glass removeFromSuperview];
    [self.web.configuration.userContentController removeScriptMessageHandlerForName:@"inspector"];
    if (_callback) napi_release_threadsafe_function(_callback, napi_tsfn_abort);
}
@end

static const char inspectorKey = 0, sidebarKey = 0, toolbarKey = 0;
static void InspectorCallback(napi_env env, napi_value callback, void *context, void *data) {
    char *text = static_cast<char *>(data);
    if (env && callback) {
        napi_value argument, global;
        napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &argument);
        napi_get_undefined(env, &global);
        napi_call_function(env, global, callback, 1, &argument, nullptr);
    }
    free(text);
}
static NSString *JSString(napi_env env, napi_value value) {
    size_t size = 0;
    if (napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok || size > 2000000) return nil;
    std::string buffer(size + 1, '\0');
    napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &size);
    return [[NSString alloc] initWithBytes:buffer.data() length:size encoding:NSUTF8StringEncoding];
}
static NSView *WindowRoot(napi_env env, napi_value value) {
    bool buffer = false; void *bytes = nullptr; size_t length = 0;
    if (napi_is_buffer(env, value, &buffer) != napi_ok || !buffer || napi_get_buffer_info(env, value, &bytes, &length) != napi_ok || length != sizeof(void *) || !NSThread.isMainThread) return nil;
    return (__bridge NSView *)(*reinterpret_cast<void **>(bytes));
}
static napi_value Inspector(napi_env env, napi_callback_info info) {
    napi_value args[4], result; size_t count = 4; bool active = false;
    napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    if (@available(macOS 26.0, *)) {
        NSView *root = count == 4 ? WindowRoot(env, args[0]) : nil;
        NSString *json = count == 4 ? JSString(env, args[1]) : nil;
        NSDictionary *state = json ? [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil] : nil;
        if (root.window && [state isKindOfClass:NSDictionary.class]) {
            NSString *surface = state[@"surface"];
            BOOL sidebar = [surface isEqualToString:@"sidebar"], toolbar = [surface isEqualToString:@"toolbar"];
            const void *key = sidebar ? &sidebarKey : toolbar ? &toolbarKey : &inspectorKey;
            MDGlassInspector *host = objc_getAssociatedObject(root, key);
            BOOL enabled = [state[@"enabled"] boolValue] && !NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceTransparency && !NSWorkspace.sharedWorkspace.accessibilityDisplayShouldIncreaseContrast;
            if (enabled && !host) {
                NSString *html = JSString(env, args[2]);
                if (!html.length) { napi_get_boolean(env, false, &result); return result; }
                host = [MDGlassInspector new];
                napi_value name; napi_create_string_utf8(env, "MediaDrop inspector", NAPI_AUTO_LENGTH, &name);
                napi_threadsafe_function callback = nullptr;
                if (napi_create_threadsafe_function(env, args[3], nullptr, name, 64, 1, nullptr, nullptr, nullptr, InspectorCallback, &callback) != napi_ok) {
                    napi_get_boolean(env, false, &result); return result;
                }
                host.callback = callback;
                WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
                configuration.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
                MDGlassMessageProxy *proxy = [MDGlassMessageProxy new]; proxy.owner = host;
                [configuration.userContentController addScriptMessageHandler:proxy name:@"inspector"];
                // WebKit must have a nonzero viewport before loading; creating it at
                // zero size can leave the first native presentation unpainted.
                NSDictionary *initialBounds = state[@"bounds"];
                NSRect initialFrame = NSMakeRect(0, 0, MAX(1, [initialBounds[@"width"] doubleValue]), MAX(1, [initialBounds[@"height"] doubleValue]));
                host.web = [[MDInspectorWebView alloc] initWithFrame:initialFrame configuration:configuration];
                host.web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
                host.web.underPageBackgroundColor = NSColor.clearColor;
                // macOS WebKit still has no public switch for its opaque page backing.
                // Guard this compatibility hook; never present opaque WebKit as glass.
                @try { [host.web setValue:@NO forKey:@"drawsBackground"]; }
                @catch (NSException *exception) { napi_get_boolean(env, false, &result); return result; }
                host.web.navigationDelegate = host;
                host.glass = [[NSGlassEffectView alloc] initWithFrame:initialFrame];
                // The floating inspector must transmit the underlying workspace.
                // Keep the material at full opacity so AppKit owns the edge optics.
                host.glass.style = (sidebar || toolbar) ? NSGlassEffectViewStyleRegular : NSGlassEffectViewStyleClear;
                if (!sidebar && !toolbar) host.glass.tintColor = NSColor.clearColor;
                host.glass.cornerRadius = toolbar ? 10 : 16;
                host.glass.contentView = host.web;
                [root.superview addSubview:host.glass positioned:NSWindowAbove relativeTo:nil];
                host.glass.accessibilityElement = YES;
                host.glass.accessibilityRole = NSAccessibilityGroupRole;
                host.glass.accessibilityLabel = sidebar ? @"资料库" : toolbar ? @"视图与设置" : @"任务详情";

                objc_setAssociatedObject(root, key, host, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
                [host.web loadHTMLString:html baseURL:nil];
            }
            if (host) {
                if (host.glass.superview != root.superview) { [host.glass removeFromSuperview]; [root.superview addSubview:host.glass positioned:NSWindowAbove relativeTo:nil]; }
                NSDictionary *bounds = state[@"bounds"];
                CGFloat x = [bounds[@"x"] doubleValue], y = [bounds[@"y"] doubleValue];
                CGFloat w = [bounds[@"width"] doubleValue], h = [bounds[@"height"] doubleValue];
                if (!root.isFlipped) y = NSHeight(root.bounds) - y - h;
                host.glass.frame = [root convertRect:NSMakeRect(x, y, w, h) toView:host.glass.superview];
                [host.glass layoutSubtreeIfNeeded];
                host.glass.alphaValue = [state[@"opacity"] doubleValue];
                host.glass.hidden = !host.presented || !enabled || ![state[@"visible"] boolValue] || w < 1 || h < 1;
                NSString *appearance = state[@"appearance"];
                host.glass.appearance = [appearance isEqualToString:@"dark"] ? [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua] : [appearance isEqualToString:@"light"] ? [NSAppearance appearanceNamed:NSAppearanceNameAqua] : nil;
                NSString *content = state[@"content"];
                if (![host.pending isEqualToString:content]) { host.pending = content; [host publish]; }
                host.web.pageZoom = [state[@"zoom"] doubleValue] ?: 1;
                active = enabled && host.presented;
            }
        }
    }
    napi_get_boolean(env, active, &result); return result;
}
