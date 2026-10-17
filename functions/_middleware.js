// 旧URL(sukioshi.pages.dev)へのアクセスを独自ドメインへ恒久転送する
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  if (url.hostname === 'sukioshi.pages.dev' && (request.method === 'GET' || request.method === 'HEAD')) {
    url.hostname = 'sukioshi.com';
    url.protocol = 'https:';
    url.port = '';
    return Response.redirect(url.toString(), 301);
  }
  return context.next();
}
