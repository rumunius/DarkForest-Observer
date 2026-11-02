// Infrastructure passthrough only. No API routes or business behavior exist yet.
export const onRequest: PagesFunction<PagesEnv> = (context) => context.next();
