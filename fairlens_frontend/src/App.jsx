import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { useTheme } from './hooks/useTheme'
import Home from './pages/Home'
import Results from './pages/Results'
import AuditResultsPage from './pages/AuditResultsPage'

export default function App() {
  useTheme() // initialise theme on mount
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/results" element={<Results />} />
        <Route path="/audit-results" element={<AuditResultsPage />} />
      </Routes>
    </BrowserRouter>
  )
}
