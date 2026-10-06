//
//  WebDAVUploadModule.mm
//  LX-Y Music
//
//  WebDAVUploadModule 的 React Native 桥接。
//  注意：使用单 NSDictionary 传参，避免多参数桥接的索引越界问题。

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(WebDAVUploadModule, RCTEventEmitter)

RCT_EXTERN_METHOD(uploadFile:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(cancelUpload:(NSString *)uploadId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
