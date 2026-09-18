export const SidebarLeft = () => {
  return (
    <div className="app-sidebar sidebar--left">
      <div className="sidebar-row sidebar-header">
        <h1 className="studio-heading">Voidmesh</h1>
      </div>
      <div className="sidebar-row">
        <p className="sidebar-text">
          Edit the look of your images and videos with different effects. All local, nothing gets
          uploaded.
        </p>
      </div>
      <div className="sidebar-row sidebar-text attribution">
        <p>
          Made by{" "}
          <a href="https://danielwargh.com" target="_blank" rel="noopener noreferrer">
            Daniel Wargh
          </a>
        </p>
      </div>
    </div>
  );
};
