import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { connectStores } from './state'
import './styles.css'

const container = document.getElementById('root')
if (container === null) throw new Error('Missing #root element')

// Connected once per document, before rendering, so StrictMode's repeated effects do not resubscribe.
const stores = connectStores(window.veydr)

createRoot(container).render(
  <StrictMode>
    <App stores={stores} />
  </StrictMode>,
)
