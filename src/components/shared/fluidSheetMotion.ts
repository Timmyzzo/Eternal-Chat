const DEFAULT_DECELERATION_RATE = 0.99;

export function projectGesture(velocity: number, decelerationRate = DEFAULT_DECELERATION_RATE) {
  return (velocity / 1000) * (decelerationRate / (1 - decelerationRate));
}

export function shouldDismissRightSheet(offset: number, velocity: number, sheetWidth: number) {
  const projectedOffset = offset + projectGesture(velocity);
  const threshold = Math.min(sheetWidth * 0.36, 144);

  return projectedOffset >= threshold;
}
