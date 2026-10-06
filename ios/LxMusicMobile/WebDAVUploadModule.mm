//
//  WebDAVUploadModule.mm
//  LX-Y Music
//
//  WebDAVUploadModule 的 React Native 桥接。

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(WebDAVUploadModule, RCTEventEmitter)

RCT_EXTERN_METHOD(uploadFile:(NSString *)urlString
                  filePath:(NSString *)filePath
                  headers:(NSDictionary<NSString *, NSString *> *)headers
                  method:(NSString *)method
                  uploadId:(NSString *)uploadId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(cancelUpload:(NSString *)uploadId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
