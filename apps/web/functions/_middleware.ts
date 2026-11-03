// Keep unavailable API routes distinct from the SPA fallback until services land.
export const onRequest: PagesFunction<PagesEnv> = async (context) => {
  const response = await context.next();
  if (new URL(context.request.url).pathname.startsWith('/api/')) {
    if (!response.headers.get('Content-Type')?.includes('application/json')) {
      return Response.json(
        { message: '服务暂时不可用，请稍后重新连接。' },
        { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
      );
    }
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'private, no-store');
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
};
