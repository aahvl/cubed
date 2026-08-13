import {
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
} from 'three'

export type CubeVariant = 0 | 1 | 2 | 3 | 4 | 5

export const CUBE_VARIANTS: CubeVariant[] = [0, 1, 2, 3, 4, 5]

export function createCubeMaterial(variant: CubeVariant) {
  switch (variant) {
    case 0:
      return new MeshStandardMaterial({
        color: '#f59e0b',
        roughness: 0.35,
        metalness: 0.1,
      })
    case 1:
      return new MeshPhysicalMaterial({
        color: '#38bdf8',
        transparent: true,
        opacity: 0.4,
        roughness: 0.05,
        metalness: 0,
        clearcoat: 1,
      })
    case 2:
      return new MeshBasicMaterial({
        color: '#18181b',
        wireframe: true,
        transparent: true,
        opacity: 0.55,
      })
    case 3:
      return new MeshStandardMaterial({
        color: '#38bdf8',
        roughness: 0.45,
        metalness: 0.2,
      })
    case 4:
      return new MeshPhysicalMaterial({
        color: '#f59e0b',
        transparent: true,
        opacity: 0.4,
        roughness: 0.1,
        metalness: 0,
        clearcoat: 1,
      })
    case 5:
      return new MeshBasicMaterial({
        color: '#f59e0b',
        wireframe: true,
        transparent: true,
        opacity: 0.5,
      })
  }
}
