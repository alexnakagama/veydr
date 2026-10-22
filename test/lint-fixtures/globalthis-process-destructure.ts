const { platform } = globalThis.process

export const isLinux = platform === 'linux'
