// Fastify dışı modüller için logger (app başlatılınca fastify logger'ı ile değiştirilir)
export let log = console
export const setLogger = (l) => (log = l)
