export const isLinux = import('node:os').then((os) => os.platform() === 'linux')
