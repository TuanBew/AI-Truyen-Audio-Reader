export interface AmbientTrack {
  id: string        // unique identifier — kebab-case for defaults, UUID for user tracks
  name: string      // display name shown in dropdown
  src: string       // URL: '/ambient/city-rain.mp3' for defaults, object URL for user tracks
  isUser?: boolean  // true for user-uploaded tracks
}

export const DEFAULT_TRACKS: AmbientTrack[] = [
  { id: 'city-rain',      name: 'City Rain Lofi',   src: '/ambient/city-rain.mp3' },
  { id: 'coffee-shop',    name: 'Coffee Shop',       src: '/ambient/coffee-shop.mp3' },
  { id: 'midnight-study', name: 'Midnight Study',    src: '/ambient/midnight-study.mp3' },
  { id: 'lo-chill',       name: 'Lo Chill',          src: '/ambient/lo-chill.mp3' },
  { id: 'forest-beats',   name: 'Forest Beats',      src: '/ambient/forest-beats.mp3' },
]
