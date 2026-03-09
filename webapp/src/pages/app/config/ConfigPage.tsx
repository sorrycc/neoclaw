import ConfigWorkspace from '../shared/ConfigWorkspace';

export default function ConfigPage({ onConfigSaved }: { onConfigSaved: () => void }) {
  return <ConfigWorkspace mode="config" onConfigSaved={onConfigSaved} />;
}
