/** Admin page hosting the live agent telemetry console. */

import AgentTelemetryConsole from '../components/AgentTelemetryConsole.jsx';
import PageHeader from '../components/PageHeader.jsx';

export default function AgentTelemetry() {
  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-8">
      <PageHeader title="Agent telemetry" description="Live view of the AI agents: routing, model latency, tool runs and retrieval confidence." />
      <AgentTelemetryConsole />
    </div>
  );
}
