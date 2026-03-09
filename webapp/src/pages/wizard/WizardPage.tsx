import ConfigWorkspace from '../app/shared/ConfigWorkspace';
export default function WizardPage({ onConfigSaved }: { onConfigSaved: () => void }) {
  return <ConfigWorkspace mode="wizard" onConfigSaved={onConfigSaved} />;
}
