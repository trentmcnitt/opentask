'use client'

import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

interface Project {
  id: number
  name: string
}

interface ProjectPickerSheetProps {
  projects: Project[]
  onSelect: (projectId: number) => void
  onClose: () => void
}

export function ProjectPickerSheet({ projects, onSelect, onClose }: ProjectPickerSheetProps) {
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="bottom" className="rounded-t-2xl" showCloseButton={true}>
        <SheetHeader>
          <SheetTitle>Move to Project</SheetTitle>
        </SheetHeader>

        <div className="grid gap-2 p-4">
          {projects.map((project) => (
            <Button
              key={project.id}
              variant="outline"
              className={cn(
                "justify-start h-auto py-3 px-4",
                "hover:bg-accent hover:text-accent-foreground"
              )}
              onClick={() => {
                onSelect(project.id)
                onClose()
              }}
            >
              <span className="w-2 h-2 rounded-full bg-primary mr-3" />
              {project.name}
            </Button>
          ))}
        </div>

        {/* Safe area padding for mobile */}
        <div className="h-6 sm:hidden" />
      </SheetContent>
    </Sheet>
  )
}
