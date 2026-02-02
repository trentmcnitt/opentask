'use client'

import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SortableProject {
  id: number
  name: string
}

interface SortableProjectListProps {
  projects: SortableProject[]
  onReorder: (projectIds: number[]) => void
  renderItem: (project: SortableProject, dragHandleProps: DragHandleProps) => React.ReactNode
}

export interface DragHandleProps {
  attributes: DraggableAttributes
  listeners: DraggableSyntheticListeners
  isDragging: boolean
}

function SortableItem({
  project,
  renderItem,
}: {
  project: SortableProject
  renderItem: SortableProjectListProps['renderItem']
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.id,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    position: isDragging ? ('relative' as const) : undefined,
  }

  return (
    <div ref={setNodeRef} style={style}>
      {renderItem(project, { attributes, listeners, isDragging })}
    </div>
  )
}

export function SortableProjectList({ projects, onReorder, renderItem }: SortableProjectListProps) {
  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: { distance: 8 },
  })

  const touchSensor = useSensor(TouchSensor, {
    activationConstraint: { delay: 250, tolerance: 5 },
  })

  const keyboardSensor = useSensor(KeyboardSensor, {
    coordinateGetter: sortableKeyboardCoordinates,
  })

  const sensors = useSensors(pointerSensor, touchSensor, keyboardSensor)

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event

    if (!over || active.id === over.id) return

    const oldIndex = projects.findIndex((p) => p.id === active.id)
    const newIndex = projects.findIndex((p) => p.id === over.id)

    if (oldIndex === -1 || newIndex === -1) return

    const newOrder = [...projects]
    const [moved] = newOrder.splice(oldIndex, 1)
    newOrder.splice(newIndex, 0, moved)

    onReorder(newOrder.map((p) => p.id))
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
      modifiers={[restrictToVerticalAxis]}
    >
      <SortableContext items={projects.map((p) => p.id)} strategy={verticalListSortingStrategy}>
        {projects.map((project) => (
          <SortableItem key={project.id} project={project} renderItem={renderItem} />
        ))}
      </SortableContext>
    </DndContext>
  )
}

export function DragHandle({
  attributes,
  listeners,
  className,
}: {
  attributes: DraggableAttributes
  listeners: DraggableSyntheticListeners
  className?: string
}) {
  return (
    <button
      type="button"
      className={cn(
        'text-muted-foreground/50 hover:text-muted-foreground cursor-grab touch-none active:cursor-grabbing',
        className,
      )}
      {...attributes}
      {...listeners}
    >
      <GripVertical className="size-4" />
    </button>
  )
}
