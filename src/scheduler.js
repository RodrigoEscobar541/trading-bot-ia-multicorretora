// scheduler.js — ponto de entrada do bot 24/7 (npm start).
//
// Na V2 é uma casca fina: sobe o endpoint de saúde (Render), inicializa a
// persistência, roda a migração V1 → V2 (única e idempotente) e entrega o
// controle ao orquestrador multi-ativo (src/nucleo/orquestrador.js).
//
// Robustez (CLAUDE.md §3.1): nenhuma falha de rodada/ativo derruba o
// processo; só a INICIALIZAÇÃO (ex.: Firebase sem credenciais) encerra.

import {
  inicializarPersistencia,
  conectarLoggerAoFirebase,
  migrarTokenTelegram,
} from './firebase/firebaseClient.js';
import {
  migrarV1paraV2,
  garantirRegrasGerais,
  garantirRegrasGeraisVenda,
  garantirPromptSupervisor,
  garantirPlataformaTT,
  garantirPlataformaBN,
  garantirPlataformaTORO,
  garantirPlataformaSTEAM,
  backfillPosicoesAbertaModo,
} from './migracao/migrarV1paraV2.js';
import { iniciarOrquestrador } from './nucleo/orquestrador.js';
import { ehPrimario } from './nucleo/instancia.js';
import { log } from './utils/logger.js';

const iniciadoEm = new Date().toISOString();

/**
 * Endpoint de saúde para hospedagem em plataformas que exigem porta HTTP
 * (ex.: Render como Web Service). Só liga quando a plataforma define PORT.
 * Também serve para um pinger externo (UptimeRobot) manter o serviço
 * acordado no plano gratuito. Não expõe nenhum dado sensível.
 */
async function iniciarServidorSaude() {
  const porta = Number(process.env.PORT);
  if (!Number.isFinite(porta) || porta <= 0) return;
  const { createServer } = await import('node:http');
  createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'no ar', iniciado_em: iniciadoEm, agora: new Date().toISOString() }));
  }).listen(porta, () => log.info(`servidor de saúde escutando na porta ${porta}`));
}

async function principal() {
  await iniciarServidorSaude();
  const backend = await inicializarPersistencia();
  conectarLoggerAoFirebase();
  log.info(`bot iniciado (persistência: ${backend})`);

  // Última linha de defesa: erros fora dos try internos não podem matar o 24/7.
  process.on('unhandledRejection', (e) => log.critico('rejeição não tratada', e));
  process.on('uncaughtException', (e) => log.critico('exceção não capturada', e));

  // Migração/seed é trabalho GLOBAL e único: com dois bots (DoisBots_Plan.MD),
  // só a instância PRIMÁRIA a executa — evita boot-race e escritas duplicadas.
  // (É idempotente; o gate só mantém o boot limpo.)
  if (ehPrimario()) {
    try {
      const migracao = await migrarV1paraV2();
      if (migracao.migrado) log.info('estrutura V2 pronta', migracao.resumo);
      await garantirRegrasGerais();
      await garantirRegrasGeraisVenda();
      await garantirPromptSupervisor();
      await garantirPlataformaTT();
      await garantirPlataformaBN();
      await garantirPlataformaTORO();
      await garantirPlataformaSTEAM();
      await backfillPosicoesAbertaModo(); // V5.2 — depois da migração (posições da V1 também precisam)
      // Segurança (2026-07-25): tira o token do Telegram do doc que o navegador
      // consegue ler e o move para `global/telegram_token`. Idempotente.
      const tg = await migrarTokenTelegram();
      if (tg.migrado) log.info('token do Telegram movido para o doc protegido (fora do alcance do navegador)');
    } catch (e) {
      // A migração é retomável: falha aqui não impede o bot de operar com o que
      // já existe — a próxima inicialização completa as cópias pendentes.
      log.critico('migração V1 → V2 falhou — seguindo; a próxima inicialização retoma as cópias', e);
    }
  } else {
    log.info('instância secundária: migração/seed a cargo da instância primária');
  }

  await iniciarOrquestrador();
}

principal().catch((e) => {
  // Só chega aqui se a INICIALIZAÇÃO falhar (ex.: Firebase sem credenciais).
  log.critico(`bot não conseguiu iniciar: ${e.message}`);
  process.exitCode = 1;
});
