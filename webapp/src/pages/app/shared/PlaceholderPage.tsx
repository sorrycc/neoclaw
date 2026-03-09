export default function PlaceholderPage({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <section className="glass-card admin-page">
      <div className="section-heading">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      <div className="placeholder-card">
        <strong>P1 开发中</strong>
        <p>本页已经接入后台导航，下一步会补完整管理能力。</p>
      </div>
    </section>
  );
}
