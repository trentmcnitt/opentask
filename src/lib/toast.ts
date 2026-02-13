import { toast as sonnerToast } from 'sonner'
import { createElement } from 'react'
import { Sparkles } from 'lucide-react'

interface ToastOptions {
  message: string
  type?: 'success' | 'error'
  action?: {
    label: string
    onClick: () => void
  }
}

export function showToast({ message, type, action }: ToastOptions) {
  const toastFn =
    type === 'success' ? sonnerToast.success : type === 'error' ? sonnerToast.error : sonnerToast
  if (action) {
    toastFn(message, {
      action: {
        label: action.label,
        onClick: action.onClick,
      },
    })
  } else {
    toastFn(message)
  }
}

export function showSuccessToast(message: string) {
  sonnerToast.success(message)
}

export function showSuccessToastWithAction(
  message: string,
  action: { label: string; onClick: () => void },
) {
  sonnerToast.success(message, { action: { label: action.label, onClick: action.onClick } })
}

export function showErrorToast(message: string) {
  sonnerToast.error(message)
}

// createElement produces a plain descriptor object (not a rendered component), so it's
// safe to create once at module scope and reuse. Sonner accepts ReactNode for its icon option.
const sparkleIcon = createElement(Sparkles, { className: 'size-4' })

export function showAiSuccessToast(message: string) {
  sonnerToast.success(message, { icon: sparkleIcon })
}

export { sonnerToast as toast }
