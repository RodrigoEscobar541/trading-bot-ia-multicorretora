// logger.js — logging central do bot.
//
// Regra de segurança (regras.md §10): nenhuma API Key pode aparecer em log,
// nem mascarada incorretamente. Todo texto passa por redigir() antes de ser
// emitido. Qualquer chave carregada em runtime (do .env ou do Firebase) deve
// ser registrada via registrarSegredo() assim que for lida.

const segredos = new Set();

// Padrões de chaves conhecidas, redigidos mesmo sem registro explícito
// (ex.: chaves do Google AI Studio começam com "AIza").
const PADROES_SENSIVEIS = [/AIza[0-9A-Za-z_-]{30,}/g];

// Destino extra opcional de persistência (ex.: coleção `logs` do Firestore,
// conectado na Etapa 3 via definirSink). O console é sempre usado.
let sink = null;

/** Registra um valor sensível para que nunca apareça em nenhum log. */
export function registrarSegredo(valor) {
  if (typeof valor === 'string' && valor.trim().length >= 8) {
    segredos.add(valor);
  }
}

/** Define uma função assíncrona que recebe cada entrada de log para persistir. */
export function definirSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
}

/** Remove segredos registrados e padrões de chave conhecidos de um texto. */
export function redigir(texto) {
  let resultado = String(texto);
  for (const segredo of segredos) {
    resultado = resultado.split(segredo).join('[REDIGIDO]');
  }
  for (const padrao of PADROES_SENSIVEIS) {
    resultado = resultado.replace(padrao, '[REDIGIDO]');
  }
  return resultado;
}

function normalizarDetalhes(detalhes) {
  if (detalhes === undefined || detalhes === null) return null;
  if (detalhes instanceof Error) {
    return { tipo: detalhes.name, erro: redigir(detalhes.message) };
  }
  try {
    return JSON.parse(redigir(JSON.stringify(detalhes)));
  } catch {
    return { valor: redigir(String(detalhes)) };
  }
}

function emitir(nivel, mensagem, detalhes) {
  const entrada = {
    nivel,
    mensagem: redigir(mensagem),
    detalhes: normalizarDetalhes(detalhes),
    horario: new Date().toISOString(),
  };

  const linha = `[${entrada.horario}] [${nivel.toUpperCase()}] ${entrada.mensagem}`;
  const saida = nivel === 'erro' || nivel === 'critico' ? console.error : console.log;
  saida(entrada.detalhes ? `${linha} ${JSON.stringify(entrada.detalhes)}` : linha);

  // Persistência é melhor-esforço: falha no sink nunca pode derrubar o loop
  // principal (CLAUDE.md §3.1).
  if (sink) {
    Promise.resolve()
      .then(() => sink(entrada))
      .catch((e) => console.error(`[logger] falha ao persistir log: ${e.message}`));
  }
  return entrada;
}

export const log = {
  info: (mensagem, detalhes) => emitir('info', mensagem, detalhes),
  aviso: (mensagem, detalhes) => emitir('aviso', mensagem, detalhes),
  erro: (mensagem, detalhes) => emitir('erro', mensagem, detalhes),
  critico: (mensagem, detalhes) => emitir('critico', mensagem, detalhes),
};
