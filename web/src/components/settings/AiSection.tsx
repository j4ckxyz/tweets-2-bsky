import { Bot } from 'lucide-react';
import { selectClassName } from '../../lib/constants';
import { useDashboard } from '../../lib/dashboard-context';
import type { AIConfig } from '../../lib/types';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

export function AiSection() {
  const { aiConfig, aiConfigured, handleSaveAiConfig, isAdmin, isBusy, setAiConfig, settingsActiveSection } =
    useDashboard();
  return settingsActiveSection === 'ai' && isAdmin ? (
    <Card className="rounded-none border-0 border-t bg-transparent">
      <CardHeader className="px-0 pb-3 pt-6 sm:px-0">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle>AI</CardTitle>
            <CardDescription>Optional enrichment and rewrite provider config.</CardDescription>
          </div>
          <Badge variant={aiConfigured ? 'success' : 'outline'}>{aiConfigured ? 'Configured' : 'Optional'}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-1 px-0 sm:px-0">
        <form className="space-y-3" onSubmit={handleSaveAiConfig}>
          <div className="space-y-2">
            <Label htmlFor="provider">Provider</Label>
            <select
              className={selectClassName}
              id="provider"
              value={aiConfig.provider}
              onChange={(event) => {
                setAiConfig((prev) => ({
                  ...prev,
                  provider: event.target.value as AIConfig['provider'],
                }));
              }}
            >
              <option value="gemini">Google Gemini</option>
              <option value="openai">OpenAI / OpenRouter</option>
              <option value="anthropic">Anthropic</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="apiKey">API Key</Label>
            <Input
              id="apiKey"
              type="password"
              value={aiConfig.apiKey || ''}
              onChange={(event) => {
                setAiConfig((prev) => ({ ...prev, apiKey: event.target.value }));
              }}
            />
          </div>
          {aiConfig.provider !== 'gemini' ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="model">Model ID</Label>
                <Input
                  id="model"
                  value={aiConfig.model || ''}
                  onChange={(event) => {
                    setAiConfig((prev) => ({ ...prev, model: event.target.value }));
                  }}
                  placeholder="gpt-4o"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="baseUrl">Base URL</Label>
                <Input
                  id="baseUrl"
                  value={aiConfig.baseUrl || ''}
                  onChange={(event) => {
                    setAiConfig((prev) => ({ ...prev, baseUrl: event.target.value }));
                  }}
                  placeholder="https://api.example.com/v1"
                />
              </div>
            </>
          ) : null}

          <Button className="w-full sm:w-auto" size="sm" type="submit" disabled={isBusy}>
            <Bot className="mr-2 h-4 w-4" />
            Save AI settings
          </Button>
        </form>
      </CardContent>
    </Card>
  ) : null;
}
