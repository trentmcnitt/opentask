import { toast as sonnerToast } from 'sonner'

interface ToastOptions {
  message: string
  action?: {
    label: string
    onClick: () => void
  }
}

export function showToast({ message, action }: ToastOptions) {
  if (action) {
    sonnerToast(message, {
      action: {
        label: action.label,
        onClick: action.onClick,
      },
    })
  } else {
    sonnerToast(message)
  }
}

export function showSuccessToast(message: string) {
  sonnerToast.success(message)
}

export function showErrorToast(message: string) {
  sonnerToast.error(message)
}

export { sonnerToast as toast }
