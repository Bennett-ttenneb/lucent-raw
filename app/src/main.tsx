import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { SecondWindow } from './components/SecondWindow'
import './styles/tokens.css'
import './styles/app.css'
import './styles/theme-light.css'
import { initTheme } from './lib/theme'

initTheme()

// the second window is the same program started with ?second=1: it shows only the photo the main window has open
const second = new URLSearchParams(window.location.search).get('second') === '1'

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{second ? <SecondWindow /> : <App />}</React.StrictMode>)
