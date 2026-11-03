import type { FastifyReply, FastifyRequest } from 'fastify';

/** Starts a Server-Sent Events response; returns a `send` function and cleans up on disconnect. */
export function startSse(req: FastifyRequest, reply: FastifyReply, onClose: () => void) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.raw.on('close', () => {
    clearInterval(ping);
    onClose();
  });
  return (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}
