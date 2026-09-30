export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function readJson(req, maxBytes = 32 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'Corpo da requisição grande demais');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

// Texto opcional do usuário: corta espaços e limita o tamanho. Vazio vira null.
export function cleanText(value, max) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'Texto inválido');
  const s = value.trim().slice(0, max);
  return s || null;
}
