import { Download, Upload } from 'lucide-react';
import { useDashboard } from '../../lib/dashboard-context';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';

export function DataSection() {
  const { handleExportConfig, handleImportConfig, importInputRef, isAdmin, settingsActiveSection } = useDashboard();
  return settingsActiveSection === 'data' && isAdmin ? (
    <Card className="rounded-none border-0 border-t bg-transparent">
      <CardHeader className="px-0 pb-3 pt-6 sm:px-0">
        <CardTitle>Data</CardTitle>
        <CardDescription>Export/import mappings and provider settings.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-1 px-0 sm:px-0">
        <Button className="w-full sm:w-auto" variant="outline" onClick={handleExportConfig}>
          <Download className="mr-2 h-4 w-4" />
          Export configuration
        </Button>
        <input
          ref={importInputRef}
          className="hidden"
          type="file"
          accept="application/json,.json"
          onChange={(event) => {
            void handleImportConfig(event);
          }}
        />
        <Button
          className="w-full sm:w-auto"
          variant="outline"
          onClick={() => {
            importInputRef.current?.click();
          }}
        >
          <Upload className="mr-2 h-4 w-4" />
          Import configuration
        </Button>
        <p className="text-xs text-muted-foreground">
          Imports preserve dashboard users and passwords while replacing mappings, provider keys, and scheduler
          settings.
        </p>
      </CardContent>
    </Card>
  ) : null;
}
