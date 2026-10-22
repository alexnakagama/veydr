declare function require(id: string): { platform(): string }

export const isLinux = require('node:os').platform() === 'linux'
