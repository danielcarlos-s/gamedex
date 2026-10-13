// Fonte única dos dados da UI. Em localhost, `?mock` troca o IndexedDB pelo dev/mock-data.js (1.000 jogos fictícios).
const useMock = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('mock');

/** Módulo com a assinatura do db.js (contrato 6.3). */
export const db = await (useMock ? import('../dev/mock-data.js') : import('./data/db.js'));
export const isMock = useMock;
