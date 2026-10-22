import { net, type WebContents } from 'electron'

/** TEST-NET-1 (RFC 5737): never routed, so a probe cannot reach a real host. */
const PROBE_HOST = '192.0.2.1'
const PROBE_URL = `http://${PROBE_HOST}/veydr-network-probe`

export const probeKinds = ['node', 'chromium', 'webrtc'] as const

/**
 * Deliberate outbound traffic used only by the `--mode probe` test build to
 * prove the no-network E2E guard detects it. Not part of the app.
 */
export function runNetworkProbe(kind: string | undefined, contents: WebContents): void {
  const swallow = (): void => undefined
  if (kind === 'node') void fetch(PROBE_URL).catch(swallow)
  if (kind === 'chromium') void net.fetch(PROBE_URL).catch(swallow)
  if (kind === 'webrtc') {
    // Lift the production hardening so the guard's UDP detection is exercised.
    contents.setWebRTCIPHandlingPolicy('default')
    void contents
      .executeJavaScript(
        `(async () => {
          const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:${PROBE_HOST}:3478' }] })
          pc.createDataChannel('probe')
          await pc.setLocalDescription(await pc.createOffer())
          await new Promise((r) => setTimeout(r, 2500))
          pc.close()
        })()`,
      )
      .catch(swallow)
  }
}
