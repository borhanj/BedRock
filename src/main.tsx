import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { YearProvider } from './data/YearContext'
import VaultProvider from './data/VaultProvider'
import './styles/tokens.css'
import './styles/app.css'

const container = document.getElementById('root')
if (!container) throw new Error('No #root element in index.html')

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <YearProvider>
        <VaultProvider>
          <App />
        </VaultProvider>
      </YearProvider>
    </BrowserRouter>
  </StrictMode>,
)
