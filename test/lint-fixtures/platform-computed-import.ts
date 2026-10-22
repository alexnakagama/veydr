const name = 'linux'

export const load = () => import(`../../src/main/platform/${name}`)
