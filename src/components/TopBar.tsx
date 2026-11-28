import { Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api";
import type { AuthStatus, Route } from "../types";
import { youtubeVideoId } from "../ui/youtube-link";
import { BorderBeam } from "@/components/ui/border-beam-search";

interface Props {
  auth: AuthStatus | null;
  query: string;
  onSubmit: (query: string) => void;
  onOpenSettings: () => void;
  onNavigate: (route: Route) => void;
}

export function TopBar({ auth, query, onSubmit, onOpenSettings, onNavigate }: Props) {
  const [text, setText] = useState(query);
  const [suggestions, setSuggestions] = useState<{ term: string; items: string[] } | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [hoveringField, setHoveringField] = useState(false);
  const [fieldFocused, setFieldFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const term = text.trim();
  const options = suggestions?.term === term ? suggestions.items : [];
  const expanded = open && options.length > 0;
  const selectedIndex = selected === null ? -1 : options.indexOf(selected);
  const activeId = expanded && selectedIndex >= 0 ? `${listId}-${selectedIndex}` : undefined;

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k" ||
          document.querySelector("dialog:modal")) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    setText(query);
    setSelected(null);
  }, [query]);

  useEffect(() => {
    if (!open || term.length < 2 || youtubeVideoId(term)) {
      setSuggestions(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .suggestions(term)
        .then((items) => {
          if (!cancelled) setSuggestions({ term, items: [...new Set(items)].slice(0, 7) });
        })
        .catch(() => {
          if (!cancelled) setSuggestions({ term, items: [] });
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, term]);

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const close = () => {
    setOpen(false);
    setSelected(null);
  };

  const submit = (value: string) => {
    const next = value.trim();
    if (!next) return;
    close();
    setText(next);
    onSubmit(next);
  };

  const initial = (auth?.account?.name ?? "G").slice(0, 1).toUpperCase();

  return (
    <div className="topbar" data-tauri-drag-region>
      <form
        className="search-pill"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          submit(text);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) close();
        }}
      >
        <BorderBeam
          className="search-beam"
          size="line"
          colorVariant="mono"
          staticColors
          duration={3.1}
          borderRadius={9}
          active={hoveringField || fieldFocused}
        >
          <div
            className="search-field"
            onPointerEnter={(event) => {
              if (event.pointerType !== "touch") setHoveringField(true);
            }}
            onPointerLeave={() => setHoveringField(false)}
            onFocus={() => setFieldFocused(true)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setFieldFocused(false);
            }}
          >
            <button type="submit" className="search-go" aria-label="Найти" title="Найти">
              <Search size={19} strokeWidth={1.8} aria-hidden />
            </button>
            <input
              ref={inputRef}
              value={text}
              enterKeyHint="search"
              spellCheck={false}
              placeholder="Поиск"
              autoComplete="off"
              role="combobox"
              aria-label="Поиск музыки"
              aria-autocomplete="list"
              aria-expanded={expanded}
              aria-controls={expanded ? listId : undefined}
              aria-activedescendant={activeId}
              aria-keyshortcuts="Control+k Meta+k"
              onPaste={(event) => {
                const pasted = event.clipboardData.getData("text/plain");
                if (!youtubeVideoId(pasted)) return;
                event.preventDefault();
                submit(pasted);
              }}
              onChange={(event) => {
                setText(event.target.value);
                setOpen(true);
                setSelected(null);
              }}
              onFocus={() => {
                setOpen(true);
                onNavigate({ name: "search" });
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit(expanded && selectedIndex >= 0 ? options[selectedIndex] : text);
                } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length > 0) {
                  event.preventDefault();
                  setOpen(true);
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  const next = selectedIndex < 0
                    ? step === 1 ? 0 : options.length - 1
                    : (selectedIndex + step + options.length) % options.length;
                  setSelected(options[next]);
                } else if (event.key === "Escape" && open) {
                  event.preventDefault();
                  close();
                }
              }}
            />
            <kbd className="search-shortcut" aria-hidden="true">Ctrl K</kbd>
          </div>
        </BorderBeam>

        {expanded ? (
          <div className="suggestions" id={listId} role="listbox" aria-label="Подсказки поиска">
            {options.map((suggestion, index) => (
              <button
                type="button"
                key={suggestion}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === selectedIndex}
                tabIndex={-1}
                className="suggestion"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => submit(suggestion)}
              >
                <Search size={13} strokeWidth={1.6} />
                <span>{suggestion}</span>
              </button>
            ))}
          </div>
        ) : null}
      </form>

      <button className="top-avatar" onClick={onOpenSettings} title="Аккаунт и настройки" aria-label="Аккаунт и настройки">
        {auth?.account?.photo ? (
          <img src={auth.account.photo} alt={auth.account.name} draggable={false} />
        ) : (
          <span>{initial}</span>
        )}
      </button>
    </div>
  );
}
