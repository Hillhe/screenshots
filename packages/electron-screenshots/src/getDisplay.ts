import { type Rectangle, screen } from 'electron';

export interface Display extends Rectangle {
  id: number;
  scaleFactor: number;
}

const normalizeDisplay = ({
  id,
  bounds,
  scaleFactor,
}: Electron.Display): Display => {
  // https://github.com/nashaofu/screenshots/issues/98
  return {
    id,
    x: Math.floor(bounds.x),
    y: Math.floor(bounds.y),
    width: Math.floor(bounds.width),
    height: Math.floor(bounds.height),
    scaleFactor,
  };
};

export const getDisplays = (): Display[] =>
  screen.getAllDisplays().map(normalizeDisplay);

export default (): Display => {
  const point = screen.getCursorScreenPoint();
  return normalizeDisplay(screen.getDisplayNearestPoint(point));
};
