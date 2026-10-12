export function AlbumView() {
  return (
    <section className="album">
      <div className="photo-stack" aria-hidden>
        <div className="photo" />
        <div className="photo" />
        <div className="photo" />
      </div>
      <span className="soon">Скоро</span>
      <h2 className="display" style={{ fontSize: 'clamp(28px, 4vw, 38px)' }}>Семейный альбом</h2>
      <p className="lede" style={{ marginBottom: 0 }}>
        Фотографии, письма и голоса семьи в одном месте, рядом с людьми из древа. Появится после того, как древо оживёт.
      </p>
    </section>
  );
}
