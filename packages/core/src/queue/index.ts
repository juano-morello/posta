// Barrel for packages/core/src/queue — the shared BullMQ contract
// (T3.1.1) both apps/api (producer) and apps/worker (consumer, T3.1.3+)
// import. Consumers import from '@posta/core' or this module, never
// reach past it into './events-queue' directly — same pattern as
// ../db/index.ts and ../redis/index.ts.
export * from './events-queue';
