/**
 * A stand-in for an S3 bucket (path-style, one bucket), for backend tests: the server uploads to it
 * with the real AWS SDK (PutObject, including the SDK's aws-chunked streaming bodies), and tests fetch
 * the pre-signed download links it hands out. Signatures are not checked: this is about what is
 * stored and served, not about AWS authentication.
 *
 *   const s3 = await startS3StandIn();
 *   startTestServer({ environment: s3.environmentFor('OFFBOARDING') })
 *   s3.objects        Map key → { body: Buffer, contentType, headers }
 *   s3.requests       every request: { method, key, query }
 */

import { createServer } from 'node:http';

export const S3_STAND_IN_BUCKET = 'nsk-test-bucket';

/** The body of an aws-chunked upload: "<hex size>;chunk-signature=…\r\n<bytes>\r\n" … "0…\r\n" trailers. */
function decodeAwsChunked(raw) {
  const chunks = [];
  let offset = 0;
  while (offset < raw.length) {
    const lineEnd = raw.indexOf('\r\n', offset);
    if (lineEnd === -1) break;
    const size = Number.parseInt(raw.subarray(offset, lineEnd).toString('latin1').split(';')[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    chunks.push(raw.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(chunks);
}

export async function startS3StandIn() {
  const s3 = { objects: new Map(), requests: [] };
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const [, bucket, ...keyParts] = url.pathname.split('/');
    const key = decodeURIComponent(keyParts.join('/'));
    s3.requests.push({ method: request.method, key, query: Object.fromEntries(url.searchParams) });
    const parts = [];
    request.on('data', (chunk) => parts.push(chunk));
    request.on('end', () => {
      if (bucket !== S3_STAND_IN_BUCKET) {
        response.writeHead(404).end();
        return;
      }
      if (request.method === 'PUT') {
        const raw = Buffer.concat(parts);
        const chunked = (request.headers['content-encoding'] ?? '').includes('aws-chunked');
        s3.objects.set(key, {
          body: chunked ? decodeAwsChunked(raw) : raw,
          contentType: request.headers['content-type'] ?? null,
          headers: request.headers,
        });
        response.writeHead(200, { ETag: '"stand-in"' }).end();
        return;
      }
      if (request.method === 'GET') {
        const object = s3.objects.get(key);
        if (!object) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, {
          'Content-Type':
            url.searchParams.get('response-content-type') ?? object.contentType ?? 'application/octet-stream',
          'Content-Disposition': url.searchParams.get('response-content-disposition') ?? 'inline',
          'Content-Length': object.body.length,
        });
        response.end(object.body);
        return;
      }
      if (request.method === 'DELETE') {
        s3.objects.delete(key);
        response.writeHead(204).end();
        return;
      }
      response.writeHead(405).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  s3.endpoint = `http://127.0.0.1:${server.address().port}`;
  /** The server variables that point one storage area (e.g. OFFBOARDING) at this stand-in. */
  s3.environmentFor = (area) => ({
    [`${area}_S3_BUCKET`]: S3_STAND_IN_BUCKET,
    [`${area}_S3_ENDPOINT`]: s3.endpoint,
    [`${area}_S3_FORCE_PATH_STYLE`]: 'true',
    [`${area}_S3_SSE`]: 'AES256',
    AWS_REGION: 'ap-south-1',
    AWS_ACCESS_KEY_ID: 'stand-in-access-key',
    AWS_SECRET_ACCESS_KEY: 'stand-in-secret-key',
  });
  s3.close = () => new Promise((resolve) => server.close(resolve));
  return s3;
}
