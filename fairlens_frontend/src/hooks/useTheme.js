import { useState, useEffect } from 'react'

export function useTheme() {
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('fairlens_theme') || 'system'
  })

  const [resolvedTheme, setResolvedTheme] = useState('dark')

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)')

    function resolve(t) {
      if (t === 'system') return mq.matches ? 'light' : 'dark'
      return t
    }

    function apply(t) {
      const r = resolve(t)
      setResolvedTheme(r)
      document.documentElement.setAttribute('data-theme', r)
    }

    apply(theme)
    const handler = () => { if (theme === 'system') apply('system') }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  function setAndSave(t) {
    localStorage.setItem('fairlens_theme', t)
    setTheme(t)
  }

  return { theme, resolvedTheme, setTheme: setAndSave }
}
