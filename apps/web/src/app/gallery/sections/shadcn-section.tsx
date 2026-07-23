import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Toast, ToastProvider, ToastTitle, ToastViewport } from '@/components/ui/toast';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// T6.5.3 — all twelve shadcn primitives (T6.2.2-9's own acceptance list:
// button, input, sheet, dialog, toast, dropdown, tabs, select, switch,
// tooltip, skeleton, badge), each under its own heading so the anchor
// nav and this test enumerate the same twelve names. Card is a 13th
// bonus primitive (T6.2.7) — not part of the official twelve, included
// anyway since it's a real, already-built primitive worth demonstrating.
//
// Overlay primitives (Sheet/Dialog/DropdownMenu/Tooltip) render their
// CLOSED trigger here, not forced pre-open: a static gallery page with
// four simultaneously-open overlays stacked on top of each other would
// be worse for inspection, not better, and a closed trigger still proves
// the primitive renders and is ready to open on its own real mechanism
// (already covered by ui-primitives.test.tsx's open/focus-trap tests) —
// this section's job is "does it render, themed, with its states,"
// not "re-prove the interaction already tested elsewhere."
function Heading({ children }: { children: string }) {
  return <h3 className="mb-3 font-sans text-base font-semibold">{children}</h3>;
}

export function ShadcnSection() {
  return (
    <div className="flex flex-col gap-10">
      <div>
        <Heading>Button</Heading>
        <div className="flex flex-wrap gap-3">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
          <Button variant="primary" loading>
            Cargando
          </Button>
        </div>
      </div>

      <div>
        <Heading>Input</Heading>
        <div className="flex max-w-sm flex-col gap-4">
          <Input placeholder="juano.example.test/promo" />
          <Input placeholder="juano.example.test/promo" error="Este slug ya existe" />
        </div>
      </div>

      <div>
        <Heading>Select</Heading>
        <Select defaultValue="terminal">
          <SelectTrigger className="max-w-sm">
            <SelectValue placeholder="Elegí un tema" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="terminal">Terminal</SelectItem>
            <SelectItem value="claro">Claro</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <Heading>Switch</Heading>
        <div className="flex items-center gap-6">
          <Switch aria-label="modo oscuro" defaultChecked />
          <Switch aria-label="notificaciones" />
        </div>
      </div>

      <div>
        <Heading>Sheet</Heading>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline">Nuevo link</Button>
          </SheetTrigger>
          <SheetContent>
            <SheetTitle>Nuevo link</SheetTitle>
          </SheetContent>
        </Sheet>
      </div>

      <div>
        <Heading>Dialog</Heading>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">Borrar link</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogTitle>¿Borrar este link?</DialogTitle>
          </DialogContent>
        </Dialog>
      </div>

      <div>
        <Heading>Dropdown menu</Heading>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">Opciones</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Editar</DropdownMenuItem>
            <DropdownMenuItem>Borrar</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div>
        <Heading>Tooltip</Heading>
        <TooltipProvider delayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost">copiar</Button>
            </TooltipTrigger>
            <TooltipContent>copiado: juano.example.test/promo</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <div>
        <Heading>Toast</Heading>
        <ToastProvider>
          <Toast open>
            <ToastTitle>link creado: juano.example.test/promo</ToastTitle>
          </Toast>
          <ToastViewport />
        </ToastProvider>
      </div>

      <div>
        <Heading>Tabs</Heading>
        <Tabs defaultValue="dia">
          <TabsList>
            <TabsTrigger value="dia">7d</TabsTrigger>
            <TabsTrigger value="mes">30d</TabsTrigger>
          </TabsList>
          <TabsContent value="dia">siete días</TabsContent>
          <TabsContent value="mes">treinta días</TabsContent>
        </Tabs>
      </div>

      <div>
        <Heading>Skeleton</Heading>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>

      <div>
        <Heading>Badge</Heading>
        <div className="flex flex-wrap gap-2">
          <Badge variant="default">default</Badge>
          <Badge variant="primary">primary</Badge>
          <Badge variant="outline">outline</Badge>
          <Badge variant="success">success</Badge>
          <Badge variant="warning">warning</Badge>
          <Badge variant="error">error</Badge>
        </div>
      </div>

      <div>
        <Heading>Card</Heading>
        <Card className="max-w-sm">
          <CardHeader>
            <CardTitle>clicks reales</CardTitle>
          </CardHeader>
        </Card>
      </div>
    </div>
  );
}
