import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Music2, Play, Pause, Search, FastForward, RotateCcw } from 'lucide-react'

// ==========================================
// 1. TYPES & API HELPERS
// ==========================================

export interface Track {
  id: number
  title: string
  artist: string
  preview_url: string
}

export interface PoolItem {
  id: number
  title: string
  artist: string
}

interface RoundResponse {
  target: Track
  pool: PoolItem[]
  artists: string[]
}

interface ArtistsResponse {
  artists: string[]
}

interface AttemptLog {
  type: 'wrong' | 'skip' | 'correct'
  label: string
  penalty: number
}

const MAX_PREVIEW_SECONDS = 15
const JUMP_DURATIONS = [5, 10, 15] as const
const STARTING_POINTS = 1000

async function fetchArtists(): Promise<string[]> {
  const res = await fetch('/api/artists')
  if (!res.ok) throw new Error('Failed to load seeded artists')
  const data: ArtistsResponse = await res.json()
  return data.artists
}

async function fetchRound(selectedArtists: string[]): Promise<RoundResponse> {
  const params = new URLSearchParams()
  if (selectedArtists.length > 0) {
    params.set('artists', selectedArtists.join(','))
  }
  const query = params.toString()
  const res = await fetch(`/api/round${query ? `?${query}` : ''}`)
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}))
    throw new Error(errBody.error || 'Failed to load round')
  }
  return res.json()
}

// ==========================================
// 2. FUZZY MATCHING UTILITIES
// ==========================================

/**
 * Sanitizes a song title by lowercasing, stripping feat./remaster parentheticals,
 * and removing non-alphanumeric characters.
 */
function sanitizeTitle(input: string): string {
  return input
    .toLowerCase()
    .replace(/\([^)]*(remaster|feat|live|version|edit)[^)]*\)/gi, '')
    .replace(/\[[^\]]*(remaster|feat|live|version|edit)[^\]]*\]/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Computes normalized Levenshtein similarity between 0 and 1.
 */
function similarityRatio(a: string, b: string): number {
  const s1 = sanitizeTitle(a)
  const s2 = sanitizeTitle(b)
  if (!s1 || !s2) return 0
  if (s1 === s2) return 1

  const rows = s1.length + 1
  const cols = s2.length + 1
  const dist: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0))

  for (let i = 0; i < rows; i++) dist[i][0] = i
  for (let j = 0; j < cols; j++) dist[0][j] = j

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1
      dist[i][j] = Math.min(
        dist[i - 1][j] + 1,
        dist[i][j - 1] + 1,
        dist[i - 1][j - 1] + cost,
      )
    }
  }

  const maxLen = Math.max(s1.length, s2.length)
  return 1 - dist[s1.length][s2.length] / maxLen
}

function isGuessMatch(guess: string, targetTitle: string): boolean {
  return similarityRatio(guess, targetTitle) >= 0.82
}

// ==========================================
// 3. MAIN APPLICATION COMPONENT
// ==========================================

export default function App() {
  // Artist filter state
  const [selectedArtists, setSelectedArtists] = useState<string[]>([])
  const [roundNonce, setRoundNonce] = useState(0)

  // Gameplay state per round
  const [unlockedSeconds, setUnlockedSeconds] = useState<number>(1)
  const [score, setScore] = useState<number>(STARTING_POINTS)
  const [skipCount, setSkipCount] = useState<number>(0)
  const [wrongCount, setWrongCount] = useState<number>(0)
  const [roundStatus, setRoundStatus] = useState<'playing' | 'won' | 'lost'>('playing')
  const [attempts, setAttempts] = useState<AttemptLog[]>([])

  // Session score & streak
  const [totalScore, setTotalScore] = useState<number>(0)
  const [streak, setStreak] = useState<number>(0)

  // Audio playback state
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [isPlaying, setIsPlaying] = useState<boolean>(false)
  const [currentTime, setCurrentTime] = useState<number>(0)

  // Autocomplete input state
  const [guessInput, setGuessInput] = useState<string>('')
  const [showDropdown, setShowDropdown] = useState<boolean>(false)
  const [highlightedIdx, setHighlightedIdx] = useState<number>(0)

  // Fetch available artists from SQLite
  const artistsQuery = useQuery({
    queryKey: ['artists'],
    queryFn: fetchArtists,
  })

  // Default to selecting all available artists once loaded
  useEffect(() => {
    if (artistsQuery.data && artistsQuery.data.length > 0 && selectedArtists.length === 0) {
      setSelectedArtists(artistsQuery.data)
    }
  }, [artistsQuery.data, selectedArtists.length])

  // Fetch current round
  const roundQuery = useQuery({
    queryKey: ['round', selectedArtists, roundNonce],
    queryFn: () => fetchRound(selectedArtists),
    enabled: artistsQuery.isSuccess,
  })

  // Reset round state whenever a new round loads
  useEffect(() => {
    if (!roundQuery.data) return
    setUnlockedSeconds(1)
    setScore(STARTING_POINTS)
    setSkipCount(0)
    setWrongCount(0)
    setRoundStatus('playing')
    setAttempts([])
    setGuessInput('')
    setShowDropdown(false)
    setIsPlaying(false)
    setCurrentTime(0)

    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      audioRef.current.load()
    }
  }, [roundQuery.data])

  // Calculate next penalties according to project-scope.md formulas:
  // Penalty_skip = 100 + (n_skips * 50)
  // Penalty_incorrect = 150 + (n_incorrect * 50)
  const nextSkipPenalty = 100 + skipCount * 50
  const nextWrongPenalty = 150 + wrongCount * 50

  // Filter scoped autocomplete pool based on current input
  const filteredSuggestions = useMemo(() => {
    const pool = roundQuery.data?.pool ?? []
    const q = sanitizeTitle(guessInput)
    if (!q) return pool.slice(0, 8)
    return pool
      .filter(
        (item) =>
          sanitizeTitle(item.title).includes(q) ||
          sanitizeTitle(item.artist).includes(q),
      )
      .slice(0, 8)
  }, [roundQuery.data?.pool, guessInput])

  // Toggle an artist in the multi-artist pool
  const toggleArtist = (artist: string) => {
    setSelectedArtists((prev) => {
      if (prev.includes(artist)) {
        // Keep at least one artist selected
        return prev.length > 1 ? prev.filter((a) => a !== artist) : prev
      }
      return [...prev, artist]
    })
  }

  // Audio playback toggle
  const togglePlayback = () => {
    const audio = audioRef.current
    if (!audio || !roundQuery.data) return

    if (isPlaying) {
      audio.pause()
      setIsPlaying(false)
    } else {
      const clampLimit = roundStatus === 'playing' ? unlockedSeconds : MAX_PREVIEW_SECONDS
      if (audio.currentTime >= clampLimit) {
        audio.currentTime = 0
      }
      audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false))
    }
  }

  // Enforce snippet clamping via HTML5 <audio> onTimeUpdate
  const handleTimeUpdate = () => {
    const audio = audioRef.current
    if (!audio) return

    const clampLimit = roundStatus === 'playing' ? unlockedSeconds : MAX_PREVIEW_SECONDS
    if (audio.currentTime >= clampLimit) {
      audio.pause()
      audio.currentTime = 0
      setCurrentTime(0)
      setIsPlaying(false)
    } else {
      setCurrentTime(audio.currentTime)
    }
  }

  // Handle "Skip More" duration jump buttons (5s, 10s, 15s)
  const handleJumpDuration = (targetSeconds: number) => {
    if (roundStatus !== 'playing' || targetSeconds <= unlockedSeconds) return

    const penalty = nextSkipPenalty
    const updatedScore = Math.max(0, score - penalty)

    setUnlockedSeconds(targetSeconds)
    setScore(updatedScore)
    setSkipCount((c) => c + 1)
    setAttempts((prev) => [
      ...prev,
      {
        type: 'skip',
        label: `Skipped to ${targetSeconds}s snippet`,
        penalty,
      },
    ])
  }

  // Submit a song guess
  const submitGuess = (submittedTitle?: string) => {
    const target = roundQuery.data?.target
    const rawGuess = (submittedTitle ?? guessInput).trim()
    if (!target || !rawGuess || roundStatus !== 'playing') return

    setShowDropdown(false)

    if (isGuessMatch(rawGuess, target.title)) {
      setRoundStatus('won')
      setTotalScore((s) => s + score)
      setStreak((s) => s + 1)
      setAttempts((prev) => [
        ...prev,
        {
          type: 'correct',
          label: `Correct! "${target.title}" — ${target.artist}`,
          penalty: 0,
        },
      ])
    } else {
      const penalty = nextWrongPenalty
      const updatedScore = Math.max(0, score - penalty)
      setScore(updatedScore)
      setWrongCount((c) => c + 1)
      setAttempts((prev) => [
        ...prev,
        {
          type: 'wrong',
          label: `Guessed "${rawGuess}"`,
          penalty,
        },
      ])
      setGuessInput('')

      if (updatedScore === 0) {
        setRoundStatus('lost')
        setStreak(0)
      }
    }
  }

  const handleGiveUp = () => {
    if (roundStatus !== 'playing') return
    setScore(0)
    setStreak(0)
    setRoundStatus('lost')
  }

  const startNextRound = () => {
    setRoundNonce((n) => n + 1)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setShowDropdown(true)
      setHighlightedIdx((i) => Math.min(i + 1, Math.max(0, filteredSuggestions.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedIdx((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (showDropdown && filteredSuggestions[highlightedIdx]) {
        const picked = filteredSuggestions[highlightedIdx]
        setGuessInput(picked.title)
        submitGuess(picked.title)
      } else {
        submitGuess()
      }
    } else if (e.key === 'Escape') {
      setShowDropdown(false)
    }
  }

  const target = roundQuery.data?.target
  const progressPct = Math.min(100, (currentTime / MAX_PREVIEW_SECONDS) * 100)
  const unlockedPct =
    roundStatus === 'playing'
      ? (unlockedSeconds / MAX_PREVIEW_SECONDS) * 100
      : 100

  return (
    <div className="app-container">
      {/* Header */}
      <header className="header">
        <div className="brand">
          <div className="brand-icon">
            <Music2 size={22} />
          </div>
          <div>
            <h1>Track Guesser</h1>
            <p>Progressive Audio Snippet Challenge</p>
          </div>
        </div>

        <div className="session-stats">
          <div className="stat-pill">
            <span>Streak</span>
            <strong>{streak}</strong>
          </div>
          <div className="stat-pill">
            <span>Total Score</span>
            <strong>{totalScore.toLocaleString()}</strong>
          </div>
        </div>
      </header>

      {/* Artist Pool Selector */}
      <section className="card">
        <div className="section-label">
          <span>Active Artist Pool</span>
          <span>{roundQuery.data?.pool.length ?? 0} songs in pool</span>
        </div>
        {artistsQuery.isLoading ? (
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            Loading seeded artists...
          </p>
        ) : artistsQuery.isError ? (
          <p style={{ fontSize: '0.85rem', color: 'var(--danger)' }}>
            Could not connect to backend API on port 8080. Make sure Go server is running.
          </p>
        ) : (
          <div className="artist-chips">
            {artistsQuery.data?.map((artist) => {
              const active = selectedArtists.includes(artist)
              return (
                <button
                  key={artist}
                  type="button"
                  className={`chip ${active ? 'active' : ''}`}
                  onClick={() => toggleArtist(artist)}
                >
                  {artist}
                </button>
              )
            })}
          </div>
        )}
      </section>

      {/* Audio Snippet Player & Clamping Controls */}
      <section className="card">
        <div className="score-banner">
          <div className="round-points">
            <span className="value">{score}</span>
            <span className="unit">pts available</span>
          </div>
          <span className="unlock-badge">
            {roundStatus === 'playing'
              ? `Clamped: ${unlockedSeconds}s / ${MAX_PREVIEW_SECONDS}s`
              : 'Full Snippet Unlocked'}
          </span>
        </div>

        {target && (
          <audio
            ref={audioRef}
            src={target.preview_url}
            preload="auto"
            onTimeUpdate={handleTimeUpdate}
            onEnded={() => {
              setIsPlaying(false)
              setCurrentTime(0)
            }}
          />
        )}

        <div className="player-controls">
          <div className="timeline-wrapper">
            <button
              type="button"
              className="play-btn"
              onClick={togglePlayback}
              disabled={!target || roundQuery.isFetching}
              aria-label={isPlaying ? 'Pause snippet' : 'Play snippet'}
            >
              {isPlaying ? <Pause size={22} /> : <Play size={22} />}
            </button>

            <div className="progress-container">
              <div className="progress-track">
                <div
                  className="progress-unlocked"
                  style={{ width: `${unlockedPct}%` }}
                />
                <div
                  className="progress-fill"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <div className="progress-markers">
                <span>{currentTime.toFixed(1)}s</span>
                <span>1s</span>
                <span>5s</span>
                <span>10s</span>
                <span>15s</span>
              </div>
            </div>
          </div>

          {/* Skip More Duration Jump Buttons (5s, 10s, 15s) */}
          <div className="jump-buttons">
            {JUMP_DURATIONS.map((sec) => {
              const isDisabled =
                roundStatus !== 'playing' || sec <= unlockedSeconds
              return (
                <button
                  key={sec}
                  type="button"
                  className="jump-btn"
                  disabled={isDisabled}
                  onClick={() => handleJumpDuration(sec)}
                >
                  <span>
                    <FastForward
                      size={13}
                      style={{ verticalAlign: '-2px', marginRight: '4px' }}
                    />
                    Unlock {sec}s
                  </span>
                  <span className="penalty">
                    {sec <= unlockedSeconds
                      ? 'Unlocked'
                      : `-${nextSkipPenalty} pts`}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </section>

      {/* Scoped Autocomplete Input & Attempts */}
      <section className="card">
        <div className="section-label">
          <span>Your Guess</span>
          <span>Wrong guess penalty: -{nextWrongPenalty} pts</span>
        </div>

        <div className="combobox-wrapper">
          <div className="input-row">
            <div className="search-input-box">
              <Search size={17} className="search-icon" />
              <input
                type="text"
                className="search-input"
                placeholder="Search songs from selected artist(s)..."
                value={guessInput}
                disabled={roundStatus !== 'playing' || !target}
                onFocus={() => setShowDropdown(true)}
                onChange={(e) => {
                  setGuessInput(e.target.value)
                  setShowDropdown(true)
                  setHighlightedIdx(0)
                }}
                onKeyDown={handleKeyDown}
              />
            </div>

            <button
              type="button"
              className="submit-btn"
              disabled={roundStatus !== 'playing' || !guessInput.trim()}
              onClick={() => submitGuess()}
            >
              Guess
            </button>

            <button
              type="button"
              className="giveup-btn"
              disabled={roundStatus !== 'playing'}
              onClick={handleGiveUp}
            >
              Give Up
            </button>
          </div>

          {showDropdown &&
            roundStatus === 'playing' &&
            filteredSuggestions.length > 0 && (
              <ul className="suggestions-list">
                {filteredSuggestions.map((item, idx) => (
                  <li
                    key={item.id}
                    className={`suggestion-item ${
                      idx === highlightedIdx ? 'highlighted' : ''
                    }`}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      setGuessInput(item.title)
                      submitGuess(item.title)
                    }}
                    onMouseEnter={() => setHighlightedIdx(idx)}
                  >
                    <span>{item.title}</span>
                    <span className="suggestion-artist">{item.artist}</span>
                  </li>
                ))}
              </ul>
            )}
        </div>

        {/* Attempt History */}
        {attempts.length > 0 && (
          <div className="attempts-list">
            {attempts.map((attempt, idx) => (
              <div key={idx} className={`attempt-row ${attempt.type}`}>
                <span>{attempt.label}</span>
                <strong>
                  {attempt.penalty > 0 ? `-${attempt.penalty} pts` : `+${score} pts`}
                </strong>
              </div>
            ))}
          </div>
        )}

        {/* Win / Loss Banner */}
        {roundStatus !== 'playing' && target && (
          <div className={`result-banner ${roundStatus}`}>
            <div>
              <strong style={{ display: 'block', fontSize: '1rem' }}>
                {roundStatus === 'won' ? '🎉 You got it!' : 'Round Over'}
              </strong>
              <span style={{ fontSize: '0.88rem', color: 'var(--text-muted)' }}>
                Answer: <strong>{target.title}</strong> by {target.artist}
              </span>
            </div>
            <button type="button" className="next-btn" onClick={startNextRound}>
              <RotateCcw size={15} />
              Next Song
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
