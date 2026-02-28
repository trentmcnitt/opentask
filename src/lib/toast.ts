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
  id?: string | number
}

export function showToast({ message, type, action, id }: ToastOptions) {
  const toastFn =
    type === 'success' ? sonnerToast.success : type === 'error' ? sonnerToast.error : sonnerToast
  if (action) {
    toastFn(message, {
      id,
      duration: 5000,
      action: {
        label: action.label,
        onClick: action.onClick,
      },
    })
  } else {
    toastFn(message, { id })
  }
}

export function showSuccessToast(message: string) {
  sonnerToast.success(message)
}

export function showSuccessToastWithAction(
  message: string,
  action: { label: string; onClick: () => void },
  options?: { id?: string | number },
) {
  sonnerToast.success(message, {
    id: options?.id,
    duration: 5000,
    action: { label: action.label, onClick: action.onClick },
  })
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

export function showAiSuccessToastWithAction(
  message: string,
  action: { label: string; onClick: () => void },
  description?: string,
) {
  sonnerToast.success(message, {
    icon: sparkleIcon,
    duration: 5000,
    description,
    action: { label: action.label, onClick: action.onClick },
  })
}

export { sonnerToast as toast }
