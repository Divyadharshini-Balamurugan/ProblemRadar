"use client";

import type { LucideIcon } from "lucide-react";
import { Building2, Compass, MapPin, Sparkles, Target, Users } from "lucide-react";

import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { EXPLORATION_CHIPS, QUICK_START_OPTIONS } from "@/lib/mock-data";
import { cn } from "@/lib/utils";
import type {
  ExplorationChip,
  QuickStartOption,
  QuickStartOptionId,
} from "@/types";

const OPTION_ICONS: Record<QuickStartOptionId, LucideIcon> = {
  discover: Sparkles,
  explore: Compass,
  investigate: Target,
};

const CHIP_ICONS: Record<ExplorationChip["category"], LucideIcon> = {
  people: Users,
  industry: Building2,
  location: MapPin,
};

interface QuickStartOptionsProps {
  selectedOptionId?: QuickStartOptionId | null;
  onSelectOption: (option: QuickStartOption) => void;
  onSelectChip: (chip: ExplorationChip) => void;
}

/**
 * Quick Start section: three primary option cards plus a row of smaller
 * exploration chips. Selecting one only guides the exploration input
 * (see `ExplorationInput`) — it never restricts free typing.
 */
export function QuickStartOptions({
  selectedOptionId,
  onSelectOption,
  onSelectChip,
}: QuickStartOptionsProps) {
  return (
    <div className="w-full space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        {QUICK_START_OPTIONS.map((option) => {
          const Icon = OPTION_ICONS[option.id];
          const isSelected = option.id === selectedOptionId;

          return (
            <Card
              key={option.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelectOption(option)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectOption(option);
                }
              }}
              className={cn(
                "cursor-pointer gap-3 p-5 transition-colors hover:border-foreground/30 hover:bg-accent/40",
                "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                isSelected && "border-primary/50 bg-accent/60"
              )}
            >
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-foreground",
                    isSelected && "bg-primary text-primary-foreground"
                  )}
                >
                  <Icon className="size-5" />
                </span>
                <CardTitle className="text-base">{option.title}</CardTitle>
              </div>
              <CardDescription className="text-sm leading-relaxed">
                {option.description}
              </CardDescription>
            </Card>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-sm font-medium text-muted-foreground">
          Or explore by
        </span>
        {EXPLORATION_CHIPS.map((chip) => {
          const Icon = CHIP_ICONS[chip.category];
          return (
            <button
              key={chip.id}
              type="button"
              onClick={() => onSelectChip(chip)}
              className="inline-flex items-center gap-1.5 rounded-full border bg-background px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none"
            >
              <Icon className="size-4 text-muted-foreground" />
              {chip.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
