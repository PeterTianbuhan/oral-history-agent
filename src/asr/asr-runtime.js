let providerFactory = null;

export function registerAsrProvider(factory) {
  if (factory !== null && typeof factory !== 'function') {
    throw new Error('asr-provider-factory-invalid');
  }
  providerFactory = factory;
}

export function hasAsrProvider() {
  return typeof providerFactory === 'function';
}

export async function startAsrSession({ config, onPartial, onFinal, onError } = {}) {
  if (!config?.enabled || !providerFactory) return null;
  const session = await providerFactory({ config, onPartial, onFinal, onError });
  if (!session || typeof session.start !== 'function') {
    throw new Error('asr-provider-session-invalid');
  }
  await session.start();
  return {
    async cutSegment() {
      if (typeof session.cutSegment !== 'function') return null;
      return session.cutSegment();
    },
    async stop() {
      if (typeof session.stop !== 'function') return null;
      return session.stop();
    },
    async abort() {
      if (typeof session.abort === 'function') await session.abort();
    },
  };
}
