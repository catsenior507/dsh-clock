import { clientBundle } from './build/tsdown.client.ts'

export default clientBundle('@dsh-external/dsh-client-plugin-clock', ['src/index.ts'], {
  portableCssModuleIds: true,
  clientEntry: 'src/client/index.tsx',
})
