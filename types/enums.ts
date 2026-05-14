// Enums, should be created using `createEnum`

/**
 * ColorSpace enum, not created using `createEnum` due to differing key-value for displayP3
 */
export const enum ColorSpace {
  srgb = "srgb",
  displayP3 = "display-p3",
}

export const enum DrawerSnapPoint {
  /** @deprecated computed from css variable */
  medium = 380,
  full = 1,
}
