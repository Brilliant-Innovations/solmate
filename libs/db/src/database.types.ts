export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  agents: {
    Tables: {
      action_cycles: {
        Row: {
          adversary_run_ids: string[]
          automation_run_id: string | null
          candidate_id: string | null
          cleared_audit_hash: string | null
          cleared_audit_sequence: number | null
          cleared_cutoff_version: number | null
          cutoffs: Json
          decision_budget_ms: number
          guideline_version_id: string | null
          id: string
          intent_id: string | null
          position_id: string | null
          proposal_id: string | null
          proposed_action:
            | Database["enums"]["Enums"]["trading_action_type"]
            | null
          proposer_run_ids: string[]
          reason_codes: unknown[]
          revision_round: number
          risk_evaluation_id: string | null
          skill_version_id: string | null
          speed_tier: Database["enums"]["Enums"]["speed_tier"]
          started_at: string
          state: Database["enums"]["Enums"]["action_cycle_state"]
          strategy_version_id: string
          terminal_at: string | null
          trigger_id: string
          unresolved_reason:
            | Database["enums"]["Enums"]["unresolved_reason"]
            | null
          updated_at: string
          verdict: Database["enums"]["Enums"]["adversary_verdict"] | null
        }
        Insert: {
          adversary_run_ids?: string[]
          automation_run_id?: string | null
          candidate_id?: string | null
          cleared_audit_hash?: string | null
          cleared_audit_sequence?: number | null
          cleared_cutoff_version?: number | null
          cutoffs: Json
          decision_budget_ms: number
          guideline_version_id?: string | null
          id?: string
          intent_id?: string | null
          position_id?: string | null
          proposal_id?: string | null
          proposed_action?:
            | Database["enums"]["Enums"]["trading_action_type"]
            | null
          proposer_run_ids?: string[]
          reason_codes?: unknown[]
          revision_round?: number
          risk_evaluation_id?: string | null
          skill_version_id?: string | null
          speed_tier: Database["enums"]["Enums"]["speed_tier"]
          started_at: string
          state?: Database["enums"]["Enums"]["action_cycle_state"]
          strategy_version_id: string
          terminal_at?: string | null
          trigger_id: string
          unresolved_reason?:
            | Database["enums"]["Enums"]["unresolved_reason"]
            | null
          updated_at?: string
          verdict?: Database["enums"]["Enums"]["adversary_verdict"] | null
        }
        Update: {
          adversary_run_ids?: string[]
          automation_run_id?: string | null
          candidate_id?: string | null
          cleared_audit_hash?: string | null
          cleared_audit_sequence?: number | null
          cleared_cutoff_version?: number | null
          cutoffs?: Json
          decision_budget_ms?: number
          guideline_version_id?: string | null
          id?: string
          intent_id?: string | null
          position_id?: string | null
          proposal_id?: string | null
          proposed_action?:
            | Database["enums"]["Enums"]["trading_action_type"]
            | null
          proposer_run_ids?: string[]
          reason_codes?: unknown[]
          revision_round?: number
          risk_evaluation_id?: string | null
          skill_version_id?: string | null
          speed_tier?: Database["enums"]["Enums"]["speed_tier"]
          started_at?: string
          state?: Database["enums"]["Enums"]["action_cycle_state"]
          strategy_version_id?: string
          terminal_at?: string | null
          trigger_id?: string
          unresolved_reason?:
            | Database["enums"]["Enums"]["unresolved_reason"]
            | null
          updated_at?: string
          verdict?: Database["enums"]["Enums"]["adversary_verdict"] | null
        }
        Relationships: [
          {
            foreignKeyName: "action_cycles_automation_run_fk"
            columns: ["automation_run_id"]
            isOneToOne: false
            referencedRelation: "automation_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "action_cycles_skill_version_id_fkey"
            columns: ["skill_version_id"]
            isOneToOne: false
            referencedRelation: "skill_versions"
            referencedColumns: ["version_id"]
          },
        ]
      }
      adversarial_reviews: {
        Row: {
          action_cycle_id: string
          agent_run_id: string | null
          blocking: boolean
          confidence: number | null
          created_at: string
          cutoff_version: number
          deterministic_gate: boolean
          id: string
          latency_ms: number
          objections: Json
          verdict: Database["enums"]["Enums"]["adversary_verdict"]
        }
        Insert: {
          action_cycle_id: string
          agent_run_id?: string | null
          blocking: boolean
          confidence?: number | null
          created_at?: string
          cutoff_version: number
          deterministic_gate: boolean
          id?: string
          latency_ms: number
          objections?: Json
          verdict: Database["enums"]["Enums"]["adversary_verdict"]
        }
        Update: {
          action_cycle_id?: string
          agent_run_id?: string | null
          blocking?: boolean
          confidence?: number | null
          created_at?: string
          cutoff_version?: number
          deterministic_gate?: boolean
          id?: string
          latency_ms?: number
          objections?: Json
          verdict?: Database["enums"]["Enums"]["adversary_verdict"]
        }
        Relationships: [
          {
            foreignKeyName: "adversarial_reviews_action_cycle_id_fkey"
            columns: ["action_cycle_id"]
            isOneToOne: false
            referencedRelation: "action_cycles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "adversarial_reviews_agent_run_id_fkey"
            columns: ["agent_run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_definitions: {
        Row: {
          context_deadline_ms: number
          cooldown_ms: number
          enabled: boolean
          enabled_modes: Database["enums"]["Enums"]["capital_authority"][]
          filter: Json
          id: string
          last_fired_at: string | null
          min_interval_ms: number
          name: string
          next_eligible_at: string | null
          priority: number
          scope: string
          skill_version_id: string
          strategy_version_id: string
          trigger_family: Database["enums"]["Enums"]["automation_trigger_family"]
          trigger_type: string
          version_id: string
        }
        Insert: {
          context_deadline_ms: number
          cooldown_ms: number
          enabled?: boolean
          enabled_modes: Database["enums"]["Enums"]["capital_authority"][]
          filter?: Json
          id?: string
          last_fired_at?: string | null
          min_interval_ms: number
          name: string
          next_eligible_at?: string | null
          priority: number
          scope: string
          skill_version_id: string
          strategy_version_id: string
          trigger_family: Database["enums"]["Enums"]["automation_trigger_family"]
          trigger_type: string
          version_id: string
        }
        Update: {
          context_deadline_ms?: number
          cooldown_ms?: number
          enabled?: boolean
          enabled_modes?: Database["enums"]["Enums"]["capital_authority"][]
          filter?: Json
          id?: string
          last_fired_at?: string | null
          min_interval_ms?: number
          name?: string
          next_eligible_at?: string | null
          priority?: number
          scope?: string
          skill_version_id?: string
          strategy_version_id?: string
          trigger_family?: Database["enums"]["Enums"]["automation_trigger_family"]
          trigger_type?: string
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_definitions_skill_version_id_fkey"
            columns: ["skill_version_id"]
            isOneToOne: false
            referencedRelation: "skill_versions"
            referencedColumns: ["version_id"]
          },
        ]
      }
      automation_runs: {
        Row: {
          action_cycle_id: string | null
          automation_id: string
          automation_version_id: string
          created_at: string
          cutoff_at: string | null
          cutoff_version: number | null
          disposition: string
          id: string
          skill_invocation_run_id: string | null
          trigger_event: Json
        }
        Insert: {
          action_cycle_id?: string | null
          automation_id: string
          automation_version_id: string
          created_at?: string
          cutoff_at?: string | null
          cutoff_version?: number | null
          disposition: string
          id?: string
          skill_invocation_run_id?: string | null
          trigger_event: Json
        }
        Update: {
          action_cycle_id?: string | null
          automation_id?: string
          automation_version_id?: string
          created_at?: string
          cutoff_at?: string | null
          cutoff_version?: number | null
          disposition?: string
          id?: string
          skill_invocation_run_id?: string | null
          trigger_event?: Json
        }
        Relationships: [
          {
            foreignKeyName: "automation_runs_action_cycle_id_fkey"
            columns: ["action_cycle_id"]
            isOneToOne: false
            referencedRelation: "action_cycles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_runs_automation_id_fkey"
            columns: ["automation_id"]
            isOneToOne: false
            referencedRelation: "automation_definitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_runs_skill_invocation_run_id_fkey"
            columns: ["skill_invocation_run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      runs: {
        Row: {
          action_cycle_id: string | null
          candidate_id: string | null
          cost_usd: number
          created_at: string
          cutoff_at: string
          cutoff_version: number
          id: string
          input_evidence_ids: string[]
          latency_ms: number
          model: string
          position_id: string | null
          prompt_version: string
          provider: string
          reasoning_config: Json | null
          role: Database["enums"]["Enums"]["agent_role"]
          schema_validation: Json
          structured_output: Json | null
          success: boolean
          temperature: number | null
          tokens: Json
        }
        Insert: {
          action_cycle_id?: string | null
          candidate_id?: string | null
          cost_usd: number
          created_at?: string
          cutoff_at: string
          cutoff_version: number
          id?: string
          input_evidence_ids?: string[]
          latency_ms: number
          model: string
          position_id?: string | null
          prompt_version: string
          provider: string
          reasoning_config?: Json | null
          role: Database["enums"]["Enums"]["agent_role"]
          schema_validation: Json
          structured_output?: Json | null
          success: boolean
          temperature?: number | null
          tokens: Json
        }
        Update: {
          action_cycle_id?: string | null
          candidate_id?: string | null
          cost_usd?: number
          created_at?: string
          cutoff_at?: string
          cutoff_version?: number
          id?: string
          input_evidence_ids?: string[]
          latency_ms?: number
          model?: string
          position_id?: string | null
          prompt_version?: string
          provider?: string
          reasoning_config?: Json | null
          role?: Database["enums"]["Enums"]["agent_role"]
          schema_validation?: Json
          structured_output?: Json | null
          success?: boolean
          temperature?: number | null
          tokens?: Json
        }
        Relationships: [
          {
            foreignKeyName: "runs_action_cycle_id_fkey"
            columns: ["action_cycle_id"]
            isOneToOne: false
            referencedRelation: "action_cycles"
            referencedColumns: ["id"]
          },
        ]
      }
      skill_versions: {
        Row: {
          adversary_policy_required: boolean
          context_builder_version: string
          effective_from: string
          effective_to: string | null
          git_sha: string
          guideline_version: string
          id: string
          proposer_model_policy_version: string
          skill_id: string
          status: Database["enums"]["Enums"]["skill_status"]
          supported_action_types: Database["enums"]["Enums"]["trading_action_type"][]
          tool_manifest_version: string
          version_id: string
          workflow_graph_version: string
        }
        Insert: {
          adversary_policy_required?: boolean
          context_builder_version: string
          effective_from: string
          effective_to?: string | null
          git_sha: string
          guideline_version: string
          id?: string
          proposer_model_policy_version: string
          skill_id: string
          status?: Database["enums"]["Enums"]["skill_status"]
          supported_action_types: Database["enums"]["Enums"]["trading_action_type"][]
          tool_manifest_version: string
          version_id: string
          workflow_graph_version: string
        }
        Update: {
          adversary_policy_required?: boolean
          context_builder_version?: string
          effective_from?: string
          effective_to?: string | null
          git_sha?: string
          guideline_version?: string
          id?: string
          proposer_model_policy_version?: string
          skill_id?: string
          status?: Database["enums"]["Enums"]["skill_status"]
          supported_action_types?: Database["enums"]["Enums"]["trading_action_type"][]
          tool_manifest_version?: string
          version_id?: string
          workflow_graph_version?: string
        }
        Relationships: []
      }
      tool_invocations: {
        Row: {
          action_cycle_id: string
          agent_run_id: string
          classification: Database["enums"]["Enums"]["tool_classification"]
          created_at: string
          cutoff_version: number
          error: string | null
          id: string
          latency_ms: number
          request_hash: string
          response_refs: string[]
          tool_name: string
          tool_version: string
        }
        Insert: {
          action_cycle_id: string
          agent_run_id: string
          classification: Database["enums"]["Enums"]["tool_classification"]
          created_at?: string
          cutoff_version: number
          error?: string | null
          id?: string
          latency_ms: number
          request_hash: string
          response_refs?: string[]
          tool_name: string
          tool_version: string
        }
        Update: {
          action_cycle_id?: string
          agent_run_id?: string
          classification?: Database["enums"]["Enums"]["tool_classification"]
          created_at?: string
          cutoff_version?: number
          error?: string | null
          id?: string
          latency_ms?: number
          request_hash?: string
          response_refs?: string[]
          tool_name?: string
          tool_version?: string
        }
        Relationships: [
          {
            foreignKeyName: "tool_invocations_action_cycle_id_fkey"
            columns: ["action_cycle_id"]
            isOneToOne: false
            referencedRelation: "action_cycles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tool_invocations_agent_run_id_fkey"
            columns: ["agent_run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      tool_refusals: {
        Row: {
          action_cycle_id: string
          agent_run_id: string
          created_at: string
          cutoff_version: number
          detail: string
          id: string
          reason: string
          request_hash: string
          requested_tool: string
        }
        Insert: {
          action_cycle_id: string
          agent_run_id: string
          created_at?: string
          cutoff_version: number
          detail: string
          id?: string
          reason: string
          request_hash: string
          requested_tool: string
        }
        Update: {
          action_cycle_id?: string
          agent_run_id?: string
          created_at?: string
          cutoff_version?: number
          detail?: string
          id?: string
          reason?: string
          request_hash?: string
          requested_tool?: string
        }
        Relationships: [
          {
            foreignKeyName: "tool_refusals_action_cycle_id_fkey"
            columns: ["action_cycle_id"]
            isOneToOne: false
            referencedRelation: "action_cycles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tool_refusals_agent_run_id_fkey"
            columns: ["agent_run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  audit: {
    Tables: {
      checkpoints: {
        Row: {
          checkpointed_at: string
          hash: string
          replicated_to: string[]
          sequence: number
        }
        Insert: {
          checkpointed_at?: string
          hash: string
          replicated_to?: string[]
          sequence: number
        }
        Update: {
          checkpointed_at?: string
          hash?: string
          replicated_to?: string[]
          sequence?: number
        }
        Relationships: [
          {
            foreignKeyName: "checkpoints_sequence_fkey"
            columns: ["sequence"]
            isOneToOne: true
            referencedRelation: "events"
            referencedColumns: ["sequence"]
          },
        ]
      }
      events: {
        Row: {
          action_class: string
          actor: Database["enums"]["Enums"]["actor_kind"]
          actor_ref: string
          after_summary: Json | null
          at: string
          authority_evidence: string | null
          before_summary: Json | null
          entity: Json
          hash: string
          id: string
          imported_at: string | null
          live_impacting: boolean
          origin: Database["enums"]["Enums"]["audit_origin"]
          original_local_at: string | null
          previous_hash: string
          sequence: number
        }
        Insert: {
          action_class: string
          actor: Database["enums"]["Enums"]["actor_kind"]
          actor_ref: string
          after_summary?: Json | null
          at?: string
          authority_evidence?: string | null
          before_summary?: Json | null
          entity: Json
          hash: string
          id?: string
          imported_at?: string | null
          live_impacting?: boolean
          origin?: Database["enums"]["Enums"]["audit_origin"]
          original_local_at?: string | null
          previous_hash: string
          sequence?: number
        }
        Update: {
          action_class?: string
          actor?: Database["enums"]["Enums"]["actor_kind"]
          actor_ref?: string
          after_summary?: Json | null
          at?: string
          authority_evidence?: string | null
          before_summary?: Json | null
          entity?: Json
          hash?: string
          id?: string
          imported_at?: string | null
          live_impacting?: boolean
          origin?: Database["enums"]["Enums"]["audit_origin"]
          original_local_at?: string | null
          previous_hash?: string
          sequence?: number
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      verify_chain: {
        Args: never
        Returns: {
          checked: number
          first_bad_sequence: number
          ok: boolean
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  core: {
    Tables: {
      asset_cohort_memberships: {
        Row: {
          approval_state: string
          asset_id: string
          cohort_id: string
          confidence: number
          created_at: string
          effective_version: string
          id: string
          source: string
        }
        Insert: {
          approval_state: string
          asset_id: string
          cohort_id: string
          confidence: number
          created_at?: string
          effective_version: string
          id?: string
          source: string
        }
        Update: {
          approval_state?: string
          asset_id?: string
          cohort_id?: string
          confidence?: number
          created_at?: string
          effective_version?: string
          id?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_cohort_memberships_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_cohort_memberships_cohort_id_fkey"
            columns: ["cohort_id"]
            isOneToOne: false
            referencedRelation: "risk_cohorts"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_eligibility: {
        Row: {
          asset_id: string
          concentration: Json | null
          created_at: string
          eligible: boolean
          emergency_exit_route_snapshot_id: string | null
          evaluated_at: string
          freeze_authority: Database["enums"]["Enums"]["authority_state"]
          freshness: Json
          grade: number | null
          hard_reject: boolean
          holder_count: number | null
          id: string
          insider_metrics: Json | null
          jupiter_route_available: boolean
          liquidity_usd: number | null
          mint_authority: Database["enums"]["Enums"]["authority_state"]
          policy_version: string
          price_impact_probes: Json
          rejection_reasons: unknown[]
          security_flags: unknown[]
          settlement_route_confirmed: boolean
          token2022: Json | null
          transfer_restrictions: unknown[]
          volume_24h_usd: number | null
        }
        Insert: {
          asset_id: string
          concentration?: Json | null
          created_at?: string
          eligible: boolean
          emergency_exit_route_snapshot_id?: string | null
          evaluated_at: string
          freeze_authority: Database["enums"]["Enums"]["authority_state"]
          freshness: Json
          grade?: number | null
          hard_reject: boolean
          holder_count?: number | null
          id?: string
          insider_metrics?: Json | null
          jupiter_route_available: boolean
          liquidity_usd?: number | null
          mint_authority: Database["enums"]["Enums"]["authority_state"]
          policy_version: string
          price_impact_probes?: Json
          rejection_reasons?: unknown[]
          security_flags?: unknown[]
          settlement_route_confirmed: boolean
          token2022?: Json | null
          transfer_restrictions?: unknown[]
          volume_24h_usd?: number | null
        }
        Update: {
          asset_id?: string
          concentration?: Json | null
          created_at?: string
          eligible?: boolean
          emergency_exit_route_snapshot_id?: string | null
          evaluated_at?: string
          freeze_authority?: Database["enums"]["Enums"]["authority_state"]
          freshness?: Json
          grade?: number | null
          hard_reject?: boolean
          holder_count?: number | null
          id?: string
          insider_metrics?: Json | null
          jupiter_route_available?: boolean
          liquidity_usd?: number | null
          mint_authority?: Database["enums"]["Enums"]["authority_state"]
          policy_version?: string
          price_impact_probes?: Json
          rejection_reasons?: unknown[]
          security_flags?: unknown[]
          settlement_route_confirmed?: boolean
          token2022?: Json | null
          transfer_restrictions?: unknown[]
          volume_24h_usd?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "asset_eligibility_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_eligibility_emergency_exit_route_snapshot_id_fkey"
            columns: ["emergency_exit_route_snapshot_id"]
            isOneToOne: false
            referencedRelation: "emergency_exit_route_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      assets: {
        Row: {
          chain: string
          created_at: string
          decimals: number
          estimated_created_at: string | null
          first_observed_at: string
          id: string
          mint_address: string
          name: string
          status: Database["enums"]["Enums"]["asset_status"]
          symbol: string
          token_program: Database["enums"]["Enums"]["token_program"]
          token_program_id: string | null
          updated_at: string
        }
        Insert: {
          chain?: string
          created_at?: string
          decimals: number
          estimated_created_at?: string | null
          first_observed_at: string
          id?: string
          mint_address: string
          name: string
          status?: Database["enums"]["Enums"]["asset_status"]
          symbol: string
          token_program: Database["enums"]["Enums"]["token_program"]
          token_program_id?: string | null
          updated_at?: string
        }
        Update: {
          chain?: string
          created_at?: string
          decimals?: number
          estimated_created_at?: string | null
          first_observed_at?: string
          id?: string
          mint_address?: string
          name?: string
          status?: Database["enums"]["Enums"]["asset_status"]
          symbol?: string
          token_program?: Database["enums"]["Enums"]["token_program"]
          token_program_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      emergency_exit_route_snapshots: {
        Row: {
          asset_id: string
          capacity: Json
          created_at: string
          hops: Json
          id: string
          last_dry_run: Json | null
          last_refresh_slot: number
          last_refreshed_at: string
          pool_state_ref: string
          settlement_mint: string
          token2022_compatible: boolean
        }
        Insert: {
          asset_id: string
          capacity?: Json
          created_at?: string
          hops: Json
          id?: string
          last_dry_run?: Json | null
          last_refresh_slot: number
          last_refreshed_at: string
          pool_state_ref: string
          settlement_mint: string
          token2022_compatible: boolean
        }
        Update: {
          asset_id?: string
          capacity?: Json
          created_at?: string
          hops?: Json
          id?: string
          last_dry_run?: Json | null
          last_refresh_slot?: number
          last_refreshed_at?: string
          pool_state_ref?: string
          settlement_mint?: string
          token2022_compatible?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "emergency_exit_route_snapshots_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
        ]
      }
      risk_cohorts: {
        Row: {
          active: boolean
          created_at: string
          id: string
          kind: string
          name: string
          version_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          kind?: string
          name: string
          version_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          kind?: string
          name?: string
          version_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  enums: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      account_mode: "LIVE" | "PAPER"
      action_cycle_state:
        | "TRIGGERED"
        | "CONTEXT_BUILT"
        | "PROPOSED"
        | "REVISION_REQUESTED"
        | "CLEARED"
        | "REJECTED"
        | "EXPIRED"
        | "UNRESOLVED"
      activity_state:
        | "OFF"
        | "STARTING"
        | "WATCH"
        | "ACTIVE"
        | "EVENT_WINDOW"
        | "WIND_DOWN"
      actor_kind:
        | "OPERATOR"
        | "WORKER"
        | "RISK_AUTHORIZER"
        | "EXECUTOR"
        | "OUT_OF_BAND_KEY"
        | "AUTOMATION"
        | "WATCHDOG"
        | "SCHEDULE"
      adversary_verdict: "CONFIRM" | "CHALLENGE" | "REJECT"
      agent_role:
        | "TRADING_PROPOSER"
        | "ACTION_ADVERSARY"
        | "EVENT_CLASSIFIER"
        | "SUMMARIZER"
      alert_severity: "INFO" | "NOTICE" | "HIGH" | "CRITICAL"
      asset_status:
        | "DISCOVERED"
        | "EVALUATING"
        | "ELIGIBLE"
        | "BLOCKED"
        | "RETIRED"
      audit_origin: "NORMAL" | "EMERGENCY_JOURNAL_IMPORT" | "WATCHDOG"
      authority_state: "NONE" | "PRESENT" | "UNKNOWN"
      automation_trigger_family: "CANDIDATE" | "OPEN_POSITION" | "SYSTEM"
      candidate_status:
        | "DETECTED"
        | "ENRICHING"
        | "REJECTED"
        | "AGENT_REVIEW"
        | "QUALIFIED"
        | "EXPIRED"
      candle_resolution: "15s" | "1m" | "5m" | "15m" | "1h" | "4h"
      capital_authority: "OBSERVE" | "PAPER" | "LIVE_APPROVAL" | "LIVE_AUTO"
      chain_commitment: "processed" | "confirmed" | "finalized"
      control_request_kind:
        | "SET_REQUESTED_MODE"
        | "PAUSE_NEW_ENTRIES"
        | "RESUME_NEW_ENTRIES"
        | "APPROVE_AUTHORIZATION"
        | "REJECT_AUTHORIZATION"
        | "MANUAL_REDUCE"
        | "MANUAL_CLOSE"
        | "EMERGENCY_CLOSE_ALL"
        | "ACKNOWLEDGE_ALERT"
        | "PROMOTE_RELEASE"
        | "ARM_RELEASE"
        | "RUN_READINESS_DRILL"
        | "START_SESSION"
        | "END_SESSION"
        | "REGISTER_PASSKEY"
        | "REVOKE_PASSKEY"
      control_request_state: "PENDING" | "ACCEPTED" | "REJECTED" | "EXPIRED"
      custody_kind:
        | "TRADING_WALLET"
        | "ASSOCIATED_TOKEN_ACCOUNT"
        | "JUPITER_TRIGGER_VAULT"
        | "APPROVED_OTHER"
      data_provenance: "LIVE" | "BACKFILL" | "REPLAY"
      deployment_profile: "P0" | "P1A" | "P1B" | "P2" | "P3" | "P4"
      emergency_command_type:
        | "PAUSE_NEW_ENTRIES"
        | "EMERGENCY_CLOSE_ASSET"
        | "EMERGENCY_CLOSE_ALL"
      event_kind:
        | "NEWS"
        | "SOCIAL"
        | "ONCHAIN"
        | "PROJECT"
        | "MACRO"
        | "LISTING"
        | "SECURITY"
        | "OTHER"
      execution_path:
        | "JUPITER_ORDER"
        | "PROVIDER_PROTECTIVE"
        | "DIRECT_POOL_PRIVATE"
        | "DIRECT_POOL_RPC"
      exposure_effect: "INCREASE" | "NEUTRAL" | "REDUCE"
      funding_event_state:
        | "PREPARED"
        | "WALLET_PROMPTED"
        | "SUBMITTED"
        | "CONFIRMED"
        | "FAILED"
        | "ABANDONED"
      intent_action:
        | "ENTER"
        | "ADD"
        | "REDUCE"
        | "EXIT"
        | "PROTECTION_INSTALL"
        | "PROTECTION_CANCEL_WITHDRAW"
        | "EMERGENCY_CLOSE"
      market_regime:
        | "RISK_ON_TREND"
        | "BROAD_SELLOFF"
        | "SOL_LED_RALLY"
        | "NARRATIVE_ROTATION"
        | "LOW_LIQUIDITY_CHOP"
        | "VOLATILITY_SHOCK"
        | "POST_EVENT_INSTABILITY"
      market_session:
        | "ASIA"
        | "EUROPE"
        | "US"
        | "ASIA_EUROPE_OVERLAP"
        | "EUROPE_US_OVERLAP"
        | "WEEKEND"
      notification_channel: "IN_APP" | "PUSH" | "TELEGRAM" | "SMS" | "EMAIL"
      operator_role: "viewer" | "operator" | "admin"
      order_attempt_state:
        | "PREPARED"
        | "SIGNED_NOT_SUBMITTED"
        | "SUBMITTED"
        | "CONFIRMED_PROVISIONAL"
        | "FINALIZED"
        | "REORG_PENDING"
        | "NOT_LANDED"
      position_review_state: "REVIEWED" | "PROTECTION_ONLY" | "BUDGET_PAUSED"
      position_safety_state:
        | "NORMAL"
        | "DEGRADED"
        | "EXIT_RECOMMENDED"
        | "CRITICAL_EXIT"
      position_status: "OPEN" | "CLOSING" | "CLOSED"
      proposal_source: "AI" | "DETERMINISTIC"
      protection_mode: "MONITORED_EXIT" | "JUPITER_TRIGGER"
      provider_health: "HEALTHY" | "DEGRADED" | "FAILED"
      release_status:
        | "DRAFT"
        | "PAPER_VALIDATED"
        | "ELIGIBLE_LIVE"
        | "ARMED"
        | "RETIRED"
      skill_status: "DRAFT" | "PAPER" | "ELIGIBLE_LIVE" | "RETIRED"
      solana_cluster: "mainnet-beta" | "devnet" | "testnet" | "localnet"
      source_quality_class:
        | "OFFICIAL_PROJECT"
        | "OFFICIAL_EXCHANGE_PROTOCOL"
        | "PRIMARY_GOVERNMENT_REGULATORY"
        | "REPUTABLE_PUBLICATION"
        | "ANALYTICS_PROVIDER"
        | "IDENTIFIED_CREATOR"
        | "UNKNOWN_SOCIAL"
      source_time_confidence: "HIGH" | "MEDIUM" | "LOW" | "ABSENT"
      speed_tier: "T0_FAST" | "T1_MOMENTUM" | "T2_CONTEXTUAL" | "T3_CATALYST"
      stop_model:
        | "ATR"
        | "STRUCTURE_LOW"
        | "PERCENTAGE"
        | "STRATEGY_INVALIDATION"
      strategy_id: "S0_RAW" | "S0_SAFE" | "S1" | "S2" | "S3" | "S4"
      strategy_status: "EXPERIMENTAL" | "PAPER" | "ELIGIBLE_LIVE" | "RETIRED"
      take_profit_policy:
        | "FIXED_R"
        | "PARTIAL_TIERS"
        | "TRAILING_AFTER_THRESHOLD"
        | "VOLATILITY_TRAIL"
        | "MOMENTUM_DECAY"
        | "TIME_STOP"
      token_program: "TOKEN" | "TOKEN_2022" | "UNKNOWN"
      tool_classification: "READ_ONLY" | "PROPOSAL_ONLY"
      trade_side: "BUY" | "SELL"
      trading_action_type:
        | "ENTER"
        | "IGNORE"
        | "HOLD"
        | "REDUCE"
        | "EXIT"
        | "ADJUST_PROTECTION"
        | "ADD"
      transaction_class:
        | "SWAP_V2"
        | "TRIGGER_DEPOSIT"
        | "TRIGGER_CANCEL_WITHDRAW"
        | "TRIGGER_AUTH_CHALLENGE"
        | "DIRECT_POOL_EMERGENCY_EXIT"
        | "SWEEP_TO_COLD_RECOVERY"
      trigger_family:
        | "MOMENTUM_CONTINUATION"
        | "EARLY_ACCELERATION"
        | "SMART_MONEY_ACCUMULATION"
        | "CATALYST_RESPONSE"
        | "SOCIAL_ACCELERATION"
        | "HOLDER_LIQUIDITY_EXPANSION"
        | "MANUAL_WATCH"
      unresolved_reason:
        | "DISAGREEMENT"
        | "ADVERSARY_UNAVAILABLE"
        | "TIMEOUT"
        | "BUDGET"
        | "MALFORMED_OUTPUT"
        | "REVISION_EXHAUSTED"
      wallet_classification:
        | "SMART_MONEY"
        | "WHALE"
        | "DEV"
        | "INSIDER"
        | "SNIPER"
        | "BUNDLER"
        | "EXCHANGE"
        | "TREASURY"
        | "OWNED"
        | "UNKNOWN"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  intelligence: {
    Tables: {
      event_assets: {
        Row: {
          asset_id: string
          event_id: string
        }
        Insert: {
          asset_id: string
          event_id: string
        }
        Update: {
          asset_id?: string
          event_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_assets_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          classification: string | null
          cluster_id: string | null
          corroborates_event_id: string | null
          first_seen_at: string
          id: string
          kind: Database["enums"]["Enums"]["event_kind"]
          last_seen_at: string
          novelty_score: number | null
          payload_hash: string
          raw_payload_ref: string | null
          sentiment: Json | null
          source_id: string
          source_provider: string
          source_published_at: string | null
          source_quality: Database["enums"]["Enums"]["source_quality_class"]
          source_time_confidence: Database["enums"]["Enums"]["source_time_confidence"]
          source_url_hash: string | null
          summary: string | null
          title: string | null
        }
        Insert: {
          classification?: string | null
          cluster_id?: string | null
          corroborates_event_id?: string | null
          first_seen_at: string
          id?: string
          kind: Database["enums"]["Enums"]["event_kind"]
          last_seen_at: string
          novelty_score?: number | null
          payload_hash: string
          raw_payload_ref?: string | null
          sentiment?: Json | null
          source_id: string
          source_provider: string
          source_published_at?: string | null
          source_quality: Database["enums"]["Enums"]["source_quality_class"]
          source_time_confidence: Database["enums"]["Enums"]["source_time_confidence"]
          source_url_hash?: string | null
          summary?: string | null
          title?: string | null
        }
        Update: {
          classification?: string | null
          cluster_id?: string | null
          corroborates_event_id?: string | null
          first_seen_at?: string
          id?: string
          kind?: Database["enums"]["Enums"]["event_kind"]
          last_seen_at?: string
          novelty_score?: number | null
          payload_hash?: string
          raw_payload_ref?: string | null
          sentiment?: Json | null
          source_id?: string
          source_provider?: string
          source_published_at?: string | null
          source_quality?: Database["enums"]["Enums"]["source_quality_class"]
          source_time_confidence?: Database["enums"]["Enums"]["source_time_confidence"]
          source_url_hash?: string | null
          summary?: string | null
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "events_corroborates_event_id_fkey"
            columns: ["corroborates_event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      owned_addresses: {
        Row: {
          account_id: string | null
          address: string
          cluster: Database["enums"]["Enums"]["solana_cluster"]
          purpose: string
          registered_at: string
          retired_at: string | null
        }
        Insert: {
          account_id?: string | null
          address: string
          cluster?: Database["enums"]["Enums"]["solana_cluster"]
          purpose: string
          registered_at?: string
          retired_at?: string | null
        }
        Update: {
          account_id?: string | null
          address?: string
          cluster?: Database["enums"]["Enums"]["solana_cluster"]
          purpose?: string
          registered_at?: string
          retired_at?: string | null
        }
        Relationships: []
      }
      wallet_cursors: {
        Row: {
          last_signature: string | null
          last_slot: number | null
          updated_at: string
          wallet: string
        }
        Insert: {
          last_signature?: string | null
          last_slot?: number | null
          updated_at?: string
          wallet: string
        }
        Update: {
          last_signature?: string | null
          last_slot?: number | null
          updated_at?: string
          wallet?: string
        }
        Relationships: [
          {
            foreignKeyName: "wallet_cursors_wallet_fkey"
            columns: ["wallet"]
            isOneToOne: true
            referencedRelation: "wallets"
            referencedColumns: ["address"]
          },
        ]
      }
      wallet_events: {
        Row: {
          amount: number
          block_time: string | null
          counterparty: string | null
          created_at: string
          decimals: number
          first_seen_at: string
          id: string
          kind: string
          mint: string | null
          movement_index: number
          payload_hash: string
          quote_amount: number | null
          quote_mint: string | null
          signature: string
          slot: number
          source: string
          wallet: string
        }
        Insert: {
          amount: number
          block_time?: string | null
          counterparty?: string | null
          created_at?: string
          decimals: number
          first_seen_at: string
          id?: string
          kind: string
          mint?: string | null
          movement_index: number
          payload_hash: string
          quote_amount?: number | null
          quote_mint?: string | null
          signature: string
          slot: number
          source: string
          wallet: string
        }
        Update: {
          amount?: number
          block_time?: string | null
          counterparty?: string | null
          created_at?: string
          decimals?: number
          first_seen_at?: string
          id?: string
          kind?: string
          mint?: string | null
          movement_index?: number
          payload_hash?: string
          quote_amount?: number | null
          quote_mint?: string | null
          signature?: string
          slot?: number
          source?: string
          wallet?: string
        }
        Relationships: [
          {
            foreignKeyName: "wallet_events_wallet_fkey"
            columns: ["wallet"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["address"]
          },
        ]
      }
      wallets: {
        Row: {
          address: string
          discovery_source: string
          first_seen_at: string
          is_owned: boolean
          labels: Json
          pnl_usd: Json
          tracking_active: boolean
          trade_count: number | null
          updated_at: string
          win_rate: number | null
        }
        Insert: {
          address: string
          discovery_source: string
          first_seen_at: string
          is_owned?: boolean
          labels?: Json
          pnl_usd?: Json
          tracking_active?: boolean
          trade_count?: number | null
          updated_at?: string
          win_rate?: number | null
        }
        Update: {
          address?: string
          discovery_source?: string
          first_seen_at?: string
          is_owned?: boolean
          labels?: Json
          pnl_usd?: Json
          tracking_active?: boolean
          trade_count?: number | null
          updated_at?: string
          win_rate?: number | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      ingest_wallet_events: {
        Args: { p_cursor: Json; p_events: Json; p_wallet: unknown }
        Returns: number
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  market: {
    Tables: {
      candles: {
        Row: {
          asset_id: string
          bucket_time: string
          close: number
          high: number
          low: number
          observed_at: string
          open: number
          provenance: Database["enums"]["Enums"]["data_provenance"]
          provider: string
          resolution: Database["enums"]["Enums"]["candle_resolution"]
          trade_count: number | null
          volume_usd: number
        }
        Insert: {
          asset_id: string
          bucket_time: string
          close: number
          high: number
          low: number
          observed_at: string
          open: number
          provenance: Database["enums"]["Enums"]["data_provenance"]
          provider: string
          resolution: Database["enums"]["Enums"]["candle_resolution"]
          trade_count?: number | null
          volume_usd: number
        }
        Update: {
          asset_id?: string
          bucket_time?: string
          close?: number
          high?: number
          low?: number
          observed_at?: string
          open?: number
          provenance?: Database["enums"]["Enums"]["data_provenance"]
          provider?: string
          resolution?: Database["enums"]["Enums"]["candle_resolution"]
          trade_count?: number | null
          volume_usd?: number
        }
        Relationships: []
      }
      candles_2026_09: {
        Row: {
          asset_id: string
          bucket_time: string
          close: number
          high: number
          low: number
          observed_at: string
          open: number
          provenance: Database["enums"]["Enums"]["data_provenance"]
          provider: string
          resolution: Database["enums"]["Enums"]["candle_resolution"]
          trade_count: number | null
          volume_usd: number
        }
        Insert: {
          asset_id: string
          bucket_time: string
          close: number
          high: number
          low: number
          observed_at: string
          open: number
          provenance: Database["enums"]["Enums"]["data_provenance"]
          provider: string
          resolution: Database["enums"]["Enums"]["candle_resolution"]
          trade_count?: number | null
          volume_usd: number
        }
        Update: {
          asset_id?: string
          bucket_time?: string
          close?: number
          high?: number
          low?: number
          observed_at?: string
          open?: number
          provenance?: Database["enums"]["Enums"]["data_provenance"]
          provider?: string
          resolution?: Database["enums"]["Enums"]["candle_resolution"]
          trade_count?: number | null
          volume_usd?: number
        }
        Relationships: []
      }
      candles_2026_10: {
        Row: {
          asset_id: string
          bucket_time: string
          close: number
          high: number
          low: number
          observed_at: string
          open: number
          provenance: Database["enums"]["Enums"]["data_provenance"]
          provider: string
          resolution: Database["enums"]["Enums"]["candle_resolution"]
          trade_count: number | null
          volume_usd: number
        }
        Insert: {
          asset_id: string
          bucket_time: string
          close: number
          high: number
          low: number
          observed_at: string
          open: number
          provenance: Database["enums"]["Enums"]["data_provenance"]
          provider: string
          resolution: Database["enums"]["Enums"]["candle_resolution"]
          trade_count?: number | null
          volume_usd: number
        }
        Update: {
          asset_id?: string
          bucket_time?: string
          close?: number
          high?: number
          low?: number
          observed_at?: string
          open?: number
          provenance?: Database["enums"]["Enums"]["data_provenance"]
          provider?: string
          resolution?: Database["enums"]["Enums"]["candle_resolution"]
          trade_count?: number | null
          volume_usd?: number
        }
        Relationships: []
      }
      candles_2026_11: {
        Row: {
          asset_id: string
          bucket_time: string
          close: number
          high: number
          low: number
          observed_at: string
          open: number
          provenance: Database["enums"]["Enums"]["data_provenance"]
          provider: string
          resolution: Database["enums"]["Enums"]["candle_resolution"]
          trade_count: number | null
          volume_usd: number
        }
        Insert: {
          asset_id: string
          bucket_time: string
          close: number
          high: number
          low: number
          observed_at: string
          open: number
          provenance: Database["enums"]["Enums"]["data_provenance"]
          provider: string
          resolution: Database["enums"]["Enums"]["candle_resolution"]
          trade_count?: number | null
          volume_usd: number
        }
        Update: {
          asset_id?: string
          bucket_time?: string
          close?: number
          high?: number
          low?: number
          observed_at?: string
          open?: number
          provenance?: Database["enums"]["Enums"]["data_provenance"]
          provider?: string
          resolution?: Database["enums"]["Enums"]["candle_resolution"]
          trade_count?: number | null
          volume_usd?: number
        }
        Relationships: []
      }
      candles_2026_12: {
        Row: {
          asset_id: string
          bucket_time: string
          close: number
          high: number
          low: number
          observed_at: string
          open: number
          provenance: Database["enums"]["Enums"]["data_provenance"]
          provider: string
          resolution: Database["enums"]["Enums"]["candle_resolution"]
          trade_count: number | null
          volume_usd: number
        }
        Insert: {
          asset_id: string
          bucket_time: string
          close: number
          high: number
          low: number
          observed_at: string
          open: number
          provenance: Database["enums"]["Enums"]["data_provenance"]
          provider: string
          resolution: Database["enums"]["Enums"]["candle_resolution"]
          trade_count?: number | null
          volume_usd: number
        }
        Update: {
          asset_id?: string
          bucket_time?: string
          close?: number
          high?: number
          low?: number
          observed_at?: string
          open?: number
          provenance?: Database["enums"]["Enums"]["data_provenance"]
          provider?: string
          resolution?: Database["enums"]["Enums"]["candle_resolution"]
          trade_count?: number | null
          volume_usd?: number
        }
        Relationships: []
      }
      candles_2027_01: {
        Row: {
          asset_id: string
          bucket_time: string
          close: number
          high: number
          low: number
          observed_at: string
          open: number
          provenance: Database["enums"]["Enums"]["data_provenance"]
          provider: string
          resolution: Database["enums"]["Enums"]["candle_resolution"]
          trade_count: number | null
          volume_usd: number
        }
        Insert: {
          asset_id: string
          bucket_time: string
          close: number
          high: number
          low: number
          observed_at: string
          open: number
          provenance: Database["enums"]["Enums"]["data_provenance"]
          provider: string
          resolution: Database["enums"]["Enums"]["candle_resolution"]
          trade_count?: number | null
          volume_usd: number
        }
        Update: {
          asset_id?: string
          bucket_time?: string
          close?: number
          high?: number
          low?: number
          observed_at?: string
          open?: number
          provenance?: Database["enums"]["Enums"]["data_provenance"]
          provider?: string
          resolution?: Database["enums"]["Enums"]["candle_resolution"]
          trade_count?: number | null
          volume_usd?: number
        }
        Relationships: []
      }
      candles_2027_02: {
        Row: {
          asset_id: string
          bucket_time: string
          close: number
          high: number
          low: number
          observed_at: string
          open: number
          provenance: Database["enums"]["Enums"]["data_provenance"]
          provider: string
          resolution: Database["enums"]["Enums"]["candle_resolution"]
          trade_count: number | null
          volume_usd: number
        }
        Insert: {
          asset_id: string
          bucket_time: string
          close: number
          high: number
          low: number
          observed_at: string
          open: number
          provenance: Database["enums"]["Enums"]["data_provenance"]
          provider: string
          resolution: Database["enums"]["Enums"]["candle_resolution"]
          trade_count?: number | null
          volume_usd: number
        }
        Update: {
          asset_id?: string
          bucket_time?: string
          close?: number
          high?: number
          low?: number
          observed_at?: string
          open?: number
          provenance?: Database["enums"]["Enums"]["data_provenance"]
          provider?: string
          resolution?: Database["enums"]["Enums"]["candle_resolution"]
          trade_count?: number | null
          volume_usd?: number
        }
        Relationships: []
      }
      quote_probes: {
        Row: {
          action_cycle_id: string | null
          asset_id: string | null
          expected_output_amount: number
          id: string
          input_amount: number
          input_mint: string
          intent_id: string | null
          min_output_amount: number
          observed_at: string
          order_attempt_id: string | null
          output_mint: string
          position_id: string | null
          price_impact_bps: number | null
          provider: string
          purpose: string
          quoted_at: string
          route_program_ids: unknown[]
          router_label: string | null
          slippage_bps: number
          uses_address_lookup_tables: boolean
        }
        Insert: {
          action_cycle_id?: string | null
          asset_id?: string | null
          expected_output_amount: number
          id?: string
          input_amount: number
          input_mint: string
          intent_id?: string | null
          min_output_amount: number
          observed_at?: string
          order_attempt_id?: string | null
          output_mint: string
          position_id?: string | null
          price_impact_bps?: number | null
          provider: string
          purpose: string
          quoted_at: string
          route_program_ids?: unknown[]
          router_label?: string | null
          slippage_bps: number
          uses_address_lookup_tables?: boolean
        }
        Update: {
          action_cycle_id?: string | null
          asset_id?: string | null
          expected_output_amount?: number
          id?: string
          input_amount?: number
          input_mint?: string
          intent_id?: string | null
          min_output_amount?: number
          observed_at?: string
          order_attempt_id?: string | null
          output_mint?: string
          position_id?: string | null
          price_impact_bps?: number | null
          provider?: string
          purpose?: string
          quoted_at?: string
          route_program_ids?: unknown[]
          router_label?: string | null
          slippage_bps?: number
          uses_address_lookup_tables?: boolean
        }
        Relationships: []
      }
      snapshots: {
        Row: {
          as_of: string
          asset_id: string
          atr: number | null
          buy_count: Json
          buy_volume_usd: Json
          created_at: string
          fdv_usd: number | null
          id: string
          liquidity_usd: number | null
          market_cap_usd: number | null
          observed_at: string
          price_usd: number | null
          provenance: Database["enums"]["Enums"]["data_provenance"]
          realized_volatility: number | null
          relative_volume: number | null
          returns: Json
          route_probes: Json
          sell_count: Json
          sell_volume_usd: Json
          sol_relative_return: number | null
          universe_relative_strength: number | null
          volume_usd: Json
        }
        Insert: {
          as_of: string
          asset_id: string
          atr?: number | null
          buy_count: Json
          buy_volume_usd: Json
          created_at?: string
          fdv_usd?: number | null
          id?: string
          liquidity_usd?: number | null
          market_cap_usd?: number | null
          observed_at: string
          price_usd?: number | null
          provenance: Database["enums"]["Enums"]["data_provenance"]
          realized_volatility?: number | null
          relative_volume?: number | null
          returns: Json
          route_probes?: Json
          sell_count: Json
          sell_volume_usd: Json
          sol_relative_return?: number | null
          universe_relative_strength?: number | null
          volume_usd: Json
        }
        Update: {
          as_of?: string
          asset_id?: string
          atr?: number | null
          buy_count?: Json
          buy_volume_usd?: Json
          created_at?: string
          fdv_usd?: number | null
          id?: string
          liquidity_usd?: number | null
          market_cap_usd?: number | null
          observed_at?: string
          price_usd?: number | null
          provenance?: Database["enums"]["Enums"]["data_provenance"]
          realized_volatility?: number | null
          relative_volume?: number | null
          returns?: Json
          route_probes?: Json
          sell_count?: Json
          sell_volume_usd?: Json
          sol_relative_return?: number | null
          universe_relative_strength?: number | null
          volume_usd?: Json
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      ensure_candle_partitions: {
        Args: { from_month: string; months: number }
        Returns: undefined
      }
      maintain_candle_partitions: { Args: never; Returns: undefined }
      prune_candles: {
        Args: never
        Returns: {
          deleted: number
          resolution: Database["enums"]["Enums"]["candle_resolution"]
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  ops: {
    Tables: {
      capital_attestations: {
        Row: {
          account_id: string
          attestation_id: string
          attested_at: string
          attested_by: string
          ceiling_usd: number
          created_at: string
          id: string
          recognized_usd_at_attestation: number | null
          release_id: string
        }
        Insert: {
          account_id: string
          attestation_id: string
          attested_at: string
          attested_by: string
          ceiling_usd: number
          created_at?: string
          id?: string
          recognized_usd_at_attestation?: number | null
          release_id: string
        }
        Update: {
          account_id?: string
          attestation_id?: string
          attested_at?: string
          attested_by?: string
          ceiling_usd?: number
          created_at?: string
          id?: string
          recognized_usd_at_attestation?: number | null
          release_id?: string
        }
        Relationships: []
      }
      chain_health: {
        Row: {
          confirmed_finalized_lag_slots: number | null
          created_at: string
          effect_on_entries: string
          head_slot: number | null
          id: string
          observed_at: string
          policy_version: string
          reasons: string[]
          slot_advanced: boolean | null
          state: string
          view_divergence_slots: number | null
          views: Json
        }
        Insert: {
          confirmed_finalized_lag_slots?: number | null
          created_at?: string
          effect_on_entries: string
          head_slot?: number | null
          id?: string
          observed_at: string
          policy_version: string
          reasons?: string[]
          slot_advanced?: boolean | null
          state: string
          view_divergence_slots?: number | null
          views: Json
        }
        Update: {
          confirmed_finalized_lag_slots?: number | null
          created_at?: string
          effect_on_entries?: string
          head_slot?: number | null
          id?: string
          observed_at?: string
          policy_version?: string
          reasons?: string[]
          slot_advanced?: boolean | null
          state?: string
          view_divergence_slots?: number | null
          views?: Json
        }
        Relationships: []
      }
      control_requests: {
        Row: {
          created_at: string
          id: string
          kind: Database["enums"]["Enums"]["control_request_kind"]
          payload: Json
          requested_by: string
          resolution: Json | null
          resolved_at: string | null
          state: Database["enums"]["Enums"]["control_request_state"]
          step_up_assertion_ref: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          kind: Database["enums"]["Enums"]["control_request_kind"]
          payload?: Json
          requested_by?: string
          resolution?: Json | null
          resolved_at?: string | null
          state?: Database["enums"]["Enums"]["control_request_state"]
          step_up_assertion_ref?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          kind?: Database["enums"]["Enums"]["control_request_kind"]
          payload?: Json
          requested_by?: string
          resolution?: Json | null
          resolved_at?: string | null
          state?: Database["enums"]["Enums"]["control_request_state"]
          step_up_assertion_ref?: string | null
        }
        Relationships: []
      }
      dead_letters: {
        Row: {
          attempts: number
          dead_lettered_at: string
          id: string
          idempotency_key: string | null
          kind: string | null
          last_error: string | null
          message: Json
          message_id: number
          queue: string
          reason: string
          resolved_at: string | null
          resolved_by: string | null
        }
        Insert: {
          attempts: number
          dead_lettered_at?: string
          id?: string
          idempotency_key?: string | null
          kind?: string | null
          last_error?: string | null
          message: Json
          message_id: number
          queue: string
          reason: string
          resolved_at?: string | null
          resolved_by?: string | null
        }
        Update: {
          attempts?: number
          dead_lettered_at?: string
          id?: string
          idempotency_key?: string | null
          kind?: string | null
          last_error?: string | null
          message?: Json
          message_id?: number
          queue?: string
          reason?: string
          resolved_at?: string | null
          resolved_by?: string | null
        }
        Relationships: []
      }
      deployment_profiles: {
        Row: {
          description: string
          live_capital_allowed: boolean
          physical_isolation: boolean
          profile: Database["enums"]["Enums"]["deployment_profile"]
          required_checks: string[]
          updated_at: string
        }
        Insert: {
          description: string
          live_capital_allowed: boolean
          physical_isolation: boolean
          profile: Database["enums"]["Enums"]["deployment_profile"]
          required_checks?: string[]
          updated_at?: string
        }
        Update: {
          description?: string
          live_capital_allowed?: boolean
          physical_isolation?: boolean
          profile?: Database["enums"]["Enums"]["deployment_profile"]
          required_checks?: string[]
          updated_at?: string
        }
        Relationships: []
      }
      notification_deliveries: {
        Row: {
          attempted_at: string
          channel: Database["enums"]["Enums"]["notification_channel"]
          confirmed_at: string | null
          error: string | null
          id: string
          notification_id: string
        }
        Insert: {
          attempted_at?: string
          channel: Database["enums"]["Enums"]["notification_channel"]
          confirmed_at?: string | null
          error?: string | null
          id?: string
          notification_id: string
        }
        Update: {
          attempted_at?: string
          channel?: Database["enums"]["Enums"]["notification_channel"]
          confirmed_at?: string | null
          error?: string | null
          id?: string
          notification_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_deliveries_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          affected: Json
          alert_class: string
          automated_response: string | null
          dead_man_action_taken: string | null
          dead_man_deadline: string | null
          escalation_level: number
          id: string
          raised_at: string
          resolved_at: string | null
          severity: Database["enums"]["Enums"]["alert_severity"]
          summary: string
          updated_at: string
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          affected?: Json
          alert_class: string
          automated_response?: string | null
          dead_man_action_taken?: string | null
          dead_man_deadline?: string | null
          escalation_level?: number
          id?: string
          raised_at?: string
          resolved_at?: string | null
          severity: Database["enums"]["Enums"]["alert_severity"]
          summary: string
          updated_at?: string
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          affected?: Json
          alert_class?: string
          automated_response?: string | null
          dead_man_action_taken?: string | null
          dead_man_deadline?: string | null
          escalation_level?: number
          id?: string
          raised_at?: string
          resolved_at?: string | null
          severity?: Database["enums"]["Enums"]["alert_severity"]
          summary?: string
          updated_at?: string
        }
        Relationships: []
      }
      operator_passkeys: {
        Row: {
          aaguid: string | null
          backed_up: boolean
          created_at: string
          credential_id: string
          id: string
          label: string
          last_used_at: string | null
          public_key_cose: string
          revoked_at: string | null
          sign_count: number
          transports: string[]
          usable_from: string
          user_id: string
        }
        Insert: {
          aaguid?: string | null
          backed_up?: boolean
          created_at?: string
          credential_id: string
          id?: string
          label: string
          last_used_at?: string | null
          public_key_cose: string
          revoked_at?: string | null
          sign_count?: number
          transports?: string[]
          usable_from?: string
          user_id: string
        }
        Update: {
          aaguid?: string | null
          backed_up?: boolean
          created_at?: string
          credential_id?: string
          id?: string
          label?: string
          last_used_at?: string | null
          public_key_cose?: string
          revoked_at?: string | null
          sign_count?: number
          transports?: string[]
          usable_from?: string
          user_id?: string
        }
        Relationships: []
      }
      operators: {
        Row: {
          created_at: string
          disabled_at: string | null
          display_name: string
          role: Database["enums"]["Enums"]["operator_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          disabled_at?: string | null
          display_name: string
          role: Database["enums"]["Enums"]["operator_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          disabled_at?: string | null
          display_name?: string
          role?: Database["enums"]["Enums"]["operator_role"]
          user_id?: string
        }
        Relationships: []
      }
      processed_messages: {
        Row: {
          idempotency_key: string
          kind: string
          message_id: number
          processed_at: string
          processed_by: string
          queue: string
          result_hash: string | null
        }
        Insert: {
          idempotency_key: string
          kind: string
          message_id: number
          processed_at?: string
          processed_by: string
          queue: string
          result_hash?: string | null
        }
        Update: {
          idempotency_key?: string
          kind?: string
          message_id?: number
          processed_at?: string
          processed_by?: string
          queue?: string
          result_hash?: string | null
        }
        Relationships: []
      }
      provider_health: {
        Row: {
          effect_on_entries: string | null
          effect_on_exits: string | null
          freshness_age_ms: number | null
          last_error: string | null
          last_success_at: string | null
          latency_ms: number | null
          provider: string
          rate_limit_state: string | null
          state: Database["enums"]["Enums"]["provider_health"]
          updated_at: string
        }
        Insert: {
          effect_on_entries?: string | null
          effect_on_exits?: string | null
          freshness_age_ms?: number | null
          last_error?: string | null
          last_success_at?: string | null
          latency_ms?: number | null
          provider: string
          rate_limit_state?: string | null
          state: Database["enums"]["Enums"]["provider_health"]
          updated_at?: string
        }
        Update: {
          effect_on_entries?: string | null
          effect_on_exits?: string | null
          freshness_age_ms?: number | null
          last_error?: string | null
          last_success_at?: string | null
          latency_ms?: number | null
          provider?: string
          rate_limit_state?: string | null
          state?: Database["enums"]["Enums"]["provider_health"]
          updated_at?: string
        }
        Relationships: []
      }
      provider_spend: {
        Row: {
          by_endpoint: Json
          month: string
          provider: string
          updated_at: string
          used_cu: number
        }
        Insert: {
          by_endpoint?: Json
          month: string
          provider: string
          updated_at?: string
          used_cu?: number
        }
        Update: {
          by_endpoint?: Json
          month?: string
          provider?: string
          updated_at?: string
          used_cu?: number
        }
        Relationships: []
      }
      retention_policies: {
        Row: {
          resolution: Database["enums"]["Enums"]["candle_resolution"]
          retention_days: number | null
          updated_at: string
        }
        Insert: {
          resolution: Database["enums"]["Enums"]["candle_resolution"]
          retention_days?: number | null
          updated_at?: string
        }
        Update: {
          resolution?: Database["enums"]["Enums"]["candle_resolution"]
          retention_days?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      runtime_sessions: {
        Row: {
          account_id: string | null
          activity_state: Database["enums"]["Enums"]["activity_state"]
          actual_end_at: string | null
          actual_start_at: string | null
          attended: boolean
          capital_authority: Database["enums"]["Enums"]["capital_authority"]
          cold_start_gates: Json
          created_at: string
          event_window: Json | null
          exposure_at_last_transition: Json
          id: string
          in_flight_execution_ids: string[]
          intended_end_at: string | null
          last_presence_heartbeat_at: string | null
          market_sessions: Database["enums"]["Enums"]["market_session"][]
          metadata: Json
          offline_resume_deadline: string | null
          paused: Json
          profile: Database["enums"]["Enums"]["deployment_profile"]
          regime: Database["enums"]["Enums"]["market_regime"] | null
          resume_watchdog: Json
          scheduled_start_at: string | null
          transitions: Json
          updated_at: string
          wind_down_blockers: string[]
        }
        Insert: {
          account_id?: string | null
          activity_state?: Database["enums"]["Enums"]["activity_state"]
          actual_end_at?: string | null
          actual_start_at?: string | null
          attended?: boolean
          capital_authority?: Database["enums"]["Enums"]["capital_authority"]
          cold_start_gates?: Json
          created_at?: string
          event_window?: Json | null
          exposure_at_last_transition?: Json
          id?: string
          in_flight_execution_ids?: string[]
          intended_end_at?: string | null
          last_presence_heartbeat_at?: string | null
          market_sessions?: Database["enums"]["Enums"]["market_session"][]
          metadata?: Json
          offline_resume_deadline?: string | null
          paused?: Json
          profile: Database["enums"]["Enums"]["deployment_profile"]
          regime?: Database["enums"]["Enums"]["market_regime"] | null
          resume_watchdog?: Json
          scheduled_start_at?: string | null
          transitions?: Json
          updated_at?: string
          wind_down_blockers?: string[]
        }
        Update: {
          account_id?: string | null
          activity_state?: Database["enums"]["Enums"]["activity_state"]
          actual_end_at?: string | null
          actual_start_at?: string | null
          attended?: boolean
          capital_authority?: Database["enums"]["Enums"]["capital_authority"]
          cold_start_gates?: Json
          created_at?: string
          event_window?: Json | null
          exposure_at_last_transition?: Json
          id?: string
          in_flight_execution_ids?: string[]
          intended_end_at?: string | null
          last_presence_heartbeat_at?: string | null
          market_sessions?: Database["enums"]["Enums"]["market_session"][]
          metadata?: Json
          offline_resume_deadline?: string | null
          paused?: Json
          profile?: Database["enums"]["Enums"]["deployment_profile"]
          regime?: Database["enums"]["Enums"]["market_regime"] | null
          resume_watchdog?: Json
          scheduled_start_at?: string | null
          transitions?: Json
          updated_at?: string
          wind_down_blockers?: string[]
        }
        Relationships: []
      }
      spend_budgets: {
        Row: {
          active: boolean
          created_at: string
          id: string
          limits: Json
          scope: string
          scope_id: string | null
          version_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          limits: Json
          scope: string
          scope_id?: string | null
          version_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          limits?: Json
          scope?: string
          scope_id?: string | null
          version_id?: string
        }
        Relationships: []
      }
      spend_usage: {
        Row: {
          budget_id: string
          cycles: number
          id: string
          model_usd: number
          provider_requests: number
          state: string
          updated_at: string
          window_end: string
          window_start: string
        }
        Insert: {
          budget_id: string
          cycles?: number
          id?: string
          model_usd?: number
          provider_requests?: number
          state?: string
          updated_at?: string
          window_end: string
          window_start: string
        }
        Update: {
          budget_id?: string
          cycles?: number
          id?: string
          model_usd?: number
          provider_requests?: number
          state?: string
          updated_at?: string
          window_end?: string
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "spend_usage_budget_id_fkey"
            columns: ["budget_id"]
            isOneToOne: false
            referencedRelation: "spend_budgets"
            referencedColumns: ["id"]
          },
        ]
      }
      step_up_assertions: {
        Row: {
          binding_hash: string
          challenge_id: string
          control_request_id: string | null
          expires_at: string
          failure_reason: string | null
          id: string
          kind: Database["enums"]["Enums"]["control_request_kind"]
          passkey_id: string | null
          user_id: string
          verified: boolean
          verified_at: string
        }
        Insert: {
          binding_hash: string
          challenge_id: string
          control_request_id?: string | null
          expires_at: string
          failure_reason?: string | null
          id?: string
          kind: Database["enums"]["Enums"]["control_request_kind"]
          passkey_id?: string | null
          user_id: string
          verified: boolean
          verified_at?: string
        }
        Update: {
          binding_hash?: string
          challenge_id?: string
          control_request_id?: string | null
          expires_at?: string
          failure_reason?: string | null
          id?: string
          kind?: Database["enums"]["Enums"]["control_request_kind"]
          passkey_id?: string | null
          user_id?: string
          verified?: boolean
          verified_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "step_up_assertions_challenge_id_fkey"
            columns: ["challenge_id"]
            isOneToOne: true
            referencedRelation: "step_up_challenges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "step_up_assertions_control_request_id_fkey"
            columns: ["control_request_id"]
            isOneToOne: false
            referencedRelation: "control_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "step_up_assertions_passkey_id_fkey"
            columns: ["passkey_id"]
            isOneToOne: false
            referencedRelation: "operator_passkeys"
            referencedColumns: ["id"]
          },
        ]
      }
      step_up_challenges: {
        Row: {
          binding_hash: string
          challenge: string
          consumed_at: string | null
          expires_at: string
          id: string
          issued_at: string
          kind: Database["enums"]["Enums"]["control_request_kind"]
          user_id: string
        }
        Insert: {
          binding_hash: string
          challenge: string
          consumed_at?: string | null
          expires_at: string
          id?: string
          issued_at?: string
          kind: Database["enums"]["Enums"]["control_request_kind"]
          user_id: string
        }
        Update: {
          binding_hash?: string
          challenge?: string
          consumed_at?: string | null
          expires_at?: string
          id?: string
          issued_at?: string
          kind?: Database["enums"]["Enums"]["control_request_kind"]
          user_id?: string
        }
        Relationships: []
      }
      wallet_funding_events: {
        Row: {
          cluster: Database["enums"]["Enums"]["solana_cluster"]
          confirmed_at: string | null
          confirmed_deltas: Json | null
          created_at: string
          destination_ata: string | null
          destination_trading_wallet: string
          failure_reason: string | null
          funding_mint: string
          id: string
          operator_user_id: string
          requested_amount: number
          source_wallet: string
          state: Database["enums"]["Enums"]["funding_event_state"]
          submitted_at: string | null
          tx_signature: string | null
          updated_at: string
        }
        Insert: {
          cluster: Database["enums"]["Enums"]["solana_cluster"]
          confirmed_at?: string | null
          confirmed_deltas?: Json | null
          created_at?: string
          destination_ata?: string | null
          destination_trading_wallet: string
          failure_reason?: string | null
          funding_mint: string
          id?: string
          operator_user_id: string
          requested_amount: number
          source_wallet: string
          state?: Database["enums"]["Enums"]["funding_event_state"]
          submitted_at?: string | null
          tx_signature?: string | null
          updated_at?: string
        }
        Update: {
          cluster?: Database["enums"]["Enums"]["solana_cluster"]
          confirmed_at?: string | null
          confirmed_deltas?: Json | null
          created_at?: string
          destination_ata?: string | null
          destination_trading_wallet?: string
          failure_reason?: string | null
          funding_mint?: string
          id?: string
          operator_user_id?: string
          requested_amount?: number
          source_wallet?: string
          state?: Database["enums"]["Enums"]["funding_event_state"]
          submitted_at?: string | null
          tx_signature?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      worker_leases: {
        Row: {
          acquired_at: string
          expires_at: string
          heartbeat_at: string
          holder: string
          role: string
        }
        Insert: {
          acquired_at?: string
          expires_at: string
          heartbeat_at?: string
          holder: string
          role: string
        }
        Update: {
          acquired_at?: string
          expires_at?: string
          heartbeat_at?: string
          holder?: string
          role?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      acquire_lease: {
        Args: { p_holder: string; p_role: string; p_ttl_seconds: number }
        Returns: boolean
      }
      begin_step_up: {
        Args: {
          p_binding_hash: unknown
          p_kind: Database["enums"]["Enums"]["control_request_kind"]
        }
        Returns: {
          challenge: string
          expires_at: string
          id: string
        }[]
      }
      charge_provider_spend: {
        Args: {
          p_cu: number
          p_endpoint: string
          p_month: string
          p_provider: string
        }
        Returns: number
      }
      charge_spend_usage: {
        Args: {
          p_budget_id: string
          p_cycles: number
          p_model_usd: number
          p_provider_requests: number
          p_window_end: string
          p_window_start: string
        }
        Returns: {
          budget_id: string
          cycles: number
          id: string
          model_usd: number
          provider_requests: number
          state: string
          updated_at: string
          window_end: string
          window_start: string
        }
        SetofOptions: {
          from: "*"
          to: "spend_usage"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      consume_step_up_challenge: {
        Args: {
          p_challenge_id: string
          p_control_request_id: string
          p_failure_reason: string
          p_passkey_id: string
          p_verified: boolean
        }
        Returns: {
          binding_hash: string
          challenge_id: string
          control_request_id: string | null
          expires_at: string
          failure_reason: string | null
          id: string
          kind: Database["enums"]["Enums"]["control_request_kind"]
          passkey_id: string | null
          user_id: string
          verified: boolean
          verified_at: string
        }
        SetofOptions: {
          from: "*"
          to: "step_up_assertions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      current_operator_role: {
        Args: never
        Returns: Database["enums"]["Enums"]["operator_role"]
      }
      has_aal2: { Args: never; Returns: boolean }
      has_role: {
        Args: { minimum: Database["enums"]["Enums"]["operator_role"] }
        Returns: boolean
      }
      heartbeat_lease: {
        Args: { p_holder: string; p_role: string; p_ttl_seconds: number }
        Returns: boolean
      }
      release_lease: {
        Args: { p_holder: string; p_role: string }
        Returns: boolean
      }
      session_aal: { Args: never; Returns: string }
      session_recent_totp: { Args: { p_within: string }; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  research: {
    Tables: {
      release_attestations: {
        Row: {
          attested_at: string
          challenge: string
          credential_fingerprint: string
          credential_id: string
          expires_at: string | null
          id: string
          operator_id: string
          operator_role: Database["enums"]["Enums"]["operator_role"]
          purpose: string
          release_digest: string
          release_id: string
          verification_result: boolean
        }
        Insert: {
          attested_at: string
          challenge: string
          credential_fingerprint: string
          credential_id: string
          expires_at?: string | null
          id?: string
          operator_id: string
          operator_role: Database["enums"]["Enums"]["operator_role"]
          purpose: string
          release_digest: string
          release_id: string
          verification_result: boolean
        }
        Update: {
          attested_at?: string
          challenge?: string
          credential_fingerprint?: string
          credential_id?: string
          expires_at?: string | null
          id?: string
          operator_id?: string
          operator_role?: Database["enums"]["Enums"]["operator_role"]
          purpose?: string
          release_digest?: string
          release_id?: string
          verification_result?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "release_attestations_release_id_fkey"
            columns: ["release_id"]
            isOneToOne: false
            referencedRelation: "releases"
            referencedColumns: ["id"]
          },
        ]
      }
      releases: {
        Row: {
          binding: Json
          created_at: string
          digest: string
          id: string
          promoted_at: string | null
          retired_at: string | null
          status: Database["enums"]["Enums"]["release_status"]
        }
        Insert: {
          binding: Json
          created_at?: string
          digest: string
          id?: string
          promoted_at?: string | null
          retired_at?: string | null
          status?: Database["enums"]["Enums"]["release_status"]
        }
        Update: {
          binding?: Json
          created_at?: string
          digest?: string
          id?: string
          promoted_at?: string | null
          retired_at?: string | null
          status?: Database["enums"]["Enums"]["release_status"]
        }
        Relationships: []
      }
      strategy_versions: {
        Row: {
          active_from: string
          active_to: string | null
          adversary_policy: Json
          allowed_action_types: Database["enums"]["Enums"]["trading_action_type"][]
          attended_presence_required_profiles: Database["enums"]["Enums"]["deployment_profile"][]
          automation_set_version_id: string | null
          chase_tolerance_bps: number
          created_at: string
          eligible_capital_authorities: Database["enums"]["Enums"]["capital_authority"][]
          event_window_policy: Json
          feature_version: string
          git_sha: string
          guideline_version_id: string | null
          human_reaction_floor_ms: number
          id: string
          live_intent_expiry_ms: number
          max_candidate_age_ms: number
          max_decision_latency_ms: number
          max_quote_age_ms: number
          model_selections: Json
          offline_protection: Json
          outside_window_behavior: string
          prompt_versions: Json
          reassessment_policy: Json
          regime_conditions: Json
          risk_policy_version: string
          session_rules: Json
          skill_version_id: string | null
          speed_tier: Database["enums"]["Enums"]["speed_tier"]
          status: Database["enums"]["Enums"]["strategy_status"]
          strategy_id: Database["enums"]["Enums"]["strategy_id"]
          thresholds: Json
          variant: string
          version_id: string
          warmup: Json
        }
        Insert: {
          active_from: string
          active_to?: string | null
          adversary_policy: Json
          allowed_action_types: Database["enums"]["Enums"]["trading_action_type"][]
          attended_presence_required_profiles?: Database["enums"]["Enums"]["deployment_profile"][]
          automation_set_version_id?: string | null
          chase_tolerance_bps: number
          created_at?: string
          eligible_capital_authorities: Database["enums"]["Enums"]["capital_authority"][]
          event_window_policy: Json
          feature_version: string
          git_sha: string
          guideline_version_id?: string | null
          human_reaction_floor_ms: number
          id?: string
          live_intent_expiry_ms: number
          max_candidate_age_ms: number
          max_decision_latency_ms: number
          max_quote_age_ms: number
          model_selections?: Json
          offline_protection: Json
          outside_window_behavior: string
          prompt_versions?: Json
          reassessment_policy?: Json
          regime_conditions?: Json
          risk_policy_version: string
          session_rules: Json
          skill_version_id?: string | null
          speed_tier: Database["enums"]["Enums"]["speed_tier"]
          status?: Database["enums"]["Enums"]["strategy_status"]
          strategy_id: Database["enums"]["Enums"]["strategy_id"]
          thresholds?: Json
          variant: string
          version_id: string
          warmup: Json
        }
        Update: {
          active_from?: string
          active_to?: string | null
          adversary_policy?: Json
          allowed_action_types?: Database["enums"]["Enums"]["trading_action_type"][]
          attended_presence_required_profiles?: Database["enums"]["Enums"]["deployment_profile"][]
          automation_set_version_id?: string | null
          chase_tolerance_bps?: number
          created_at?: string
          eligible_capital_authorities?: Database["enums"]["Enums"]["capital_authority"][]
          event_window_policy?: Json
          feature_version?: string
          git_sha?: string
          guideline_version_id?: string | null
          human_reaction_floor_ms?: number
          id?: string
          live_intent_expiry_ms?: number
          max_candidate_age_ms?: number
          max_decision_latency_ms?: number
          max_quote_age_ms?: number
          model_selections?: Json
          offline_protection?: Json
          outside_window_behavior?: string
          prompt_versions?: Json
          reassessment_policy?: Json
          regime_conditions?: Json
          risk_policy_version?: string
          session_rules?: Json
          skill_version_id?: string | null
          speed_tier?: Database["enums"]["Enums"]["speed_tier"]
          status?: Database["enums"]["Enums"]["strategy_status"]
          strategy_id?: Database["enums"]["Enums"]["strategy_id"]
          thresholds?: Json
          variant?: string
          version_id?: string
          warmup?: Json
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  risk: {
    Tables: {
      correlation_clusters: {
        Row: {
          calculated_at: string
          clusters: Json
          id: string
          method: string
          version_id: string
          window_end: string
          window_start: string
        }
        Insert: {
          calculated_at: string
          clusters: Json
          id?: string
          method: string
          version_id: string
          window_end: string
          window_start: string
        }
        Update: {
          calculated_at?: string
          clusters?: Json
          id?: string
          method?: string
          version_id?: string
          window_end?: string
          window_start?: string
        }
        Relationships: []
      }
      state_projections: {
        Row: {
          account_id: string
          as_of: string
          chain_slot: number
          created_at: string
          envelope: Json
          id: string
          key_id: string
          payload_hash: string
          sequence: number
        }
        Insert: {
          account_id: string
          as_of: string
          chain_slot: number
          created_at?: string
          envelope: Json
          id?: string
          key_id: string
          payload_hash: string
          sequence: number
        }
        Update: {
          account_id?: string
          as_of?: string
          chain_slot?: number
          created_at?: string
          envelope?: Json
          id?: string
          key_id?: string
          payload_hash?: string
          sequence?: number
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  signals: {
    Tables: {
      candidates: {
        Row: {
          asset_id: string
          created_at: string
          dedupe_key: string
          deterministic_rejection_reason: string | null
          discovered_at: string
          eligibility_evaluation_id: string
          expires_at: string
          feature_snapshot_id: string
          id: string
          scanner_score: number
          status: Database["enums"]["Enums"]["candidate_status"]
          strategy_version_ids: unknown[]
          trigger_details: Json
          trigger_family: Database["enums"]["Enums"]["trigger_family"]
          updated_at: string
        }
        Insert: {
          asset_id: string
          created_at?: string
          dedupe_key: string
          deterministic_rejection_reason?: string | null
          discovered_at: string
          eligibility_evaluation_id: string
          expires_at: string
          feature_snapshot_id: string
          id?: string
          scanner_score: number
          status?: Database["enums"]["Enums"]["candidate_status"]
          strategy_version_ids?: unknown[]
          trigger_details?: Json
          trigger_family: Database["enums"]["Enums"]["trigger_family"]
          updated_at?: string
        }
        Update: {
          asset_id?: string
          created_at?: string
          dedupe_key?: string
          deterministic_rejection_reason?: string | null
          discovered_at?: string
          eligibility_evaluation_id?: string
          expires_at?: string
          feature_snapshot_id?: string
          id?: string
          scanner_score?: number
          status?: Database["enums"]["Enums"]["candidate_status"]
          strategy_version_ids?: unknown[]
          trigger_details?: Json
          trigger_family?: Database["enums"]["Enums"]["trigger_family"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "candidates_feature_snapshot_id_fkey"
            columns: ["feature_snapshot_id"]
            isOneToOne: false
            referencedRelation: "feature_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_snapshots: {
        Row: {
          as_of: string
          asset_id: string
          created_at: string
          feature_engine_version: string
          features: Json
          id: string
          market_sessions: Database["enums"]["Enums"]["market_session"][]
          market_snapshot_id: string | null
          provenance: Database["enums"]["Enums"]["data_provenance"]
          regime: Database["enums"]["Enums"]["market_regime"] | null
          self_influence_suppressed: boolean
        }
        Insert: {
          as_of: string
          asset_id: string
          created_at?: string
          feature_engine_version: string
          features: Json
          id?: string
          market_sessions?: Database["enums"]["Enums"]["market_session"][]
          market_snapshot_id?: string | null
          provenance: Database["enums"]["Enums"]["data_provenance"]
          regime?: Database["enums"]["Enums"]["market_regime"] | null
          self_influence_suppressed?: boolean
        }
        Update: {
          as_of?: string
          asset_id?: string
          created_at?: string
          feature_engine_version?: string
          features?: Json
          id?: string
          market_sessions?: Database["enums"]["Enums"]["market_session"][]
          market_snapshot_id?: string | null
          provenance?: Database["enums"]["Enums"]["data_provenance"]
          regime?: Database["enums"]["Enums"]["market_regime"] | null
          self_influence_suppressed?: boolean
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  trading: {
    Tables: {
      accounts: {
        Row: {
          cluster: Database["enums"]["Enums"]["solana_cluster"]
          created_at: string
          id: string
          mode: Database["enums"]["Enums"]["account_mode"]
          name: string
          settlement_mint: string
          trading_wallet: string
        }
        Insert: {
          cluster: Database["enums"]["Enums"]["solana_cluster"]
          created_at?: string
          id?: string
          mode?: Database["enums"]["Enums"]["account_mode"]
          name: string
          settlement_mint: string
          trading_wallet: string
        }
        Update: {
          cluster?: Database["enums"]["Enums"]["solana_cluster"]
          created_at?: string
          id?: string
          mode?: Database["enums"]["Enums"]["account_mode"]
          name?: string
          settlement_mint?: string
          trading_wallet?: string
        }
        Relationships: []
      }
      approvals: {
        Row: {
          approver_id: string
          authorization_hash: string
          envelope: Json
          expires_at: string
          granted_at: string
          id: string
          intent_id: string
          nonce: string
          revoked_at: string | null
          role: Database["enums"]["Enums"]["operator_role"]
          step_up_assertion_ref: string | null
        }
        Insert: {
          approver_id: string
          authorization_hash: string
          envelope: Json
          expires_at: string
          granted_at: string
          id?: string
          intent_id: string
          nonce: string
          revoked_at?: string | null
          role: Database["enums"]["Enums"]["operator_role"]
          step_up_assertion_ref?: string | null
        }
        Update: {
          approver_id?: string
          authorization_hash?: string
          envelope?: Json
          expires_at?: string
          granted_at?: string
          id?: string
          intent_id?: string
          nonce?: string
          revoked_at?: string | null
          role?: Database["enums"]["Enums"]["operator_role"]
          step_up_assertion_ref?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "approvals_authorization_hash_fkey"
            columns: ["authorization_hash"]
            isOneToOne: false
            referencedRelation: "risk_authorizations"
            referencedColumns: ["authorization_hash"]
          },
          {
            foreignKeyName: "approvals_intent_id_fkey"
            columns: ["intent_id"]
            isOneToOne: false
            referencedRelation: "intents"
            referencedColumns: ["id"]
          },
        ]
      }
      custody_accounts: {
        Row: {
          account_id: string
          active_from: string
          active_to: string | null
          address: string
          allowed_movement_types: Database["enums"]["Enums"]["transaction_class"][]
          id: string
          kind: Database["enums"]["Enums"]["custody_kind"]
          mint: string | null
          owner_provider: string
          verification_state: string
        }
        Insert: {
          account_id: string
          active_from: string
          active_to?: string | null
          address: string
          allowed_movement_types?: Database["enums"]["Enums"]["transaction_class"][]
          id?: string
          kind: Database["enums"]["Enums"]["custody_kind"]
          mint?: string | null
          owner_provider: string
          verification_state: string
        }
        Update: {
          account_id?: string
          active_from?: string
          active_to?: string | null
          address?: string
          allowed_movement_types?: Database["enums"]["Enums"]["transaction_class"][]
          id?: string
          kind?: Database["enums"]["Enums"]["custody_kind"]
          mint?: string | null
          owner_provider?: string
          verification_state?: string
        }
        Relationships: [
          {
            foreignKeyName: "custody_accounts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      custody_movements: {
        Row: {
          account_id: string
          amount: number
          block_time: string | null
          classification: string
          created_at: string
          decimals: number
          failed: boolean
          from_owner: string | null
          from_token_account: string | null
          kind: string
          lifecycle_id: string | null
          mint: string | null
          movement_index: number
          reason: string | null
          reconciliation_id: string
          signature: string
          slot: number
          summary_type: string | null
          to_owner: string | null
          to_token_account: string | null
        }
        Insert: {
          account_id: string
          amount: number
          block_time?: string | null
          classification: string
          created_at?: string
          decimals: number
          failed?: boolean
          from_owner?: string | null
          from_token_account?: string | null
          kind: string
          lifecycle_id?: string | null
          mint?: string | null
          movement_index: number
          reason?: string | null
          reconciliation_id: string
          signature: string
          slot: number
          summary_type?: string | null
          to_owner?: string | null
          to_token_account?: string | null
        }
        Update: {
          account_id?: string
          amount?: number
          block_time?: string | null
          classification?: string
          created_at?: string
          decimals?: number
          failed?: boolean
          from_owner?: string | null
          from_token_account?: string | null
          kind?: string
          lifecycle_id?: string | null
          mint?: string | null
          movement_index?: number
          reason?: string | null
          reconciliation_id?: string
          signature?: string
          slot?: number
          summary_type?: string | null
          to_owner?: string | null
          to_token_account?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "custody_movements_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "custody_movements_reconciliation_id_fkey"
            columns: ["reconciliation_id"]
            isOneToOne: false
            referencedRelation: "custody_reconciliations"
            referencedColumns: ["id"]
          },
        ]
      }
      custody_reconciliations: {
        Row: {
          account_id: string
          balances: Json
          chain_slot: number | null
          created_at: string
          cursor: Json
          evaluated_at: string
          id: string
          movement_source: string
          pause_triggered: boolean
          policy_version: string
          reasons: unknown[]
          status: string
          unexpected_token_accounts: Json
          unparsed_signatures: string[]
        }
        Insert: {
          account_id: string
          balances: Json
          chain_slot?: number | null
          created_at?: string
          cursor: Json
          evaluated_at: string
          id?: string
          movement_source: string
          pause_triggered: boolean
          policy_version: string
          reasons?: unknown[]
          status: string
          unexpected_token_accounts?: Json
          unparsed_signatures?: string[]
        }
        Update: {
          account_id?: string
          balances?: Json
          chain_slot?: number | null
          created_at?: string
          cursor?: Json
          evaluated_at?: string
          id?: string
          movement_source?: string
          pause_triggered?: boolean
          policy_version?: string
          reasons?: unknown[]
          status?: string
          unexpected_token_accounts?: Json
          unparsed_signatures?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "custody_reconciliations_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      fills: {
        Row: {
          commitment: Database["enums"]["Enums"]["chain_commitment"]
          created_at: string
          execution_path: Database["enums"]["Enums"]["execution_path"]
          execution_shortfall_bps: number | null
          fees: Json
          filled_at: string
          id: string
          input_amount: number
          input_mint: string
          lot_allocations: Json
          order_attempt_id: string
          output_amount: number
          output_mint: string
          slot: number
          tx_signature: string
        }
        Insert: {
          commitment: Database["enums"]["Enums"]["chain_commitment"]
          created_at?: string
          execution_path: Database["enums"]["Enums"]["execution_path"]
          execution_shortfall_bps?: number | null
          fees: Json
          filled_at: string
          id?: string
          input_amount: number
          input_mint: string
          lot_allocations?: Json
          order_attempt_id: string
          output_amount: number
          output_mint: string
          slot: number
          tx_signature: string
        }
        Update: {
          commitment?: Database["enums"]["Enums"]["chain_commitment"]
          created_at?: string
          execution_path?: Database["enums"]["Enums"]["execution_path"]
          execution_shortfall_bps?: number | null
          fees?: Json
          filled_at?: string
          id?: string
          input_amount?: number
          input_mint?: string
          lot_allocations?: Json
          order_attempt_id?: string
          output_amount?: number
          output_mint?: string
          slot?: number
          tx_signature?: string
        }
        Relationships: [
          {
            foreignKeyName: "fills_order_attempt_id_fkey"
            columns: ["order_attempt_id"]
            isOneToOne: false
            referencedRelation: "order_attempts"
            referencedColumns: ["id"]
          },
        ]
      }
      intents: {
        Row: {
          account_id: string
          action: Database["enums"]["Enums"]["intent_action"]
          action_cycle_id: string
          approval_required: boolean
          asset_id: string
          cleared_cutoff_version: number
          constraints: Json
          created_at: string
          expires_at: string
          exposure_effect: Database["enums"]["Enums"]["exposure_effect"]
          id: string
          idempotency_key: string
          input_mint: string
          lifecycle_state: string
          max_input_amount: number
          output_mint: string
          protection_policy_ref: string | null
          risk_evaluation_id: string
          side: Database["enums"]["Enums"]["trade_side"]
          sleeve_id: string | null
          strategy_version_id: string
          target_lot_ids: string[]
          updated_at: string
        }
        Insert: {
          account_id: string
          action: Database["enums"]["Enums"]["intent_action"]
          action_cycle_id: string
          approval_required: boolean
          asset_id: string
          cleared_cutoff_version: number
          constraints: Json
          created_at: string
          expires_at: string
          exposure_effect: Database["enums"]["Enums"]["exposure_effect"]
          id?: string
          idempotency_key: string
          input_mint: string
          lifecycle_state?: string
          max_input_amount: number
          output_mint: string
          protection_policy_ref?: string | null
          risk_evaluation_id: string
          side: Database["enums"]["Enums"]["trade_side"]
          sleeve_id?: string | null
          strategy_version_id: string
          target_lot_ids?: string[]
          updated_at?: string
        }
        Update: {
          account_id?: string
          action?: Database["enums"]["Enums"]["intent_action"]
          action_cycle_id?: string
          approval_required?: boolean
          asset_id?: string
          cleared_cutoff_version?: number
          constraints?: Json
          created_at?: string
          expires_at?: string
          exposure_effect?: Database["enums"]["Enums"]["exposure_effect"]
          id?: string
          idempotency_key?: string
          input_mint?: string
          lifecycle_state?: string
          max_input_amount?: number
          output_mint?: string
          protection_policy_ref?: string | null
          risk_evaluation_id?: string
          side?: Database["enums"]["Enums"]["trade_side"]
          sleeve_id?: string | null
          strategy_version_id?: string
          target_lot_ids?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "intents_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intents_risk_evaluation_id_fkey"
            columns: ["risk_evaluation_id"]
            isOneToOne: false
            referencedRelation: "risk_evaluations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intents_sleeve_id_fkey"
            columns: ["sleeve_id"]
            isOneToOne: false
            referencedRelation: "strategy_sleeves"
            referencedColumns: ["id"]
          },
        ]
      }
      order_attempts: {
        Row: {
          attempt_number: number
          authorization_hash: string | null
          blockhash: string | null
          confirmed_at: string | null
          confirmed_slot: number | null
          created_at: string
          expected_tx_signature: string | null
          finalized_at: string | null
          finalized_slot: number | null
          id: string
          intent_id: string
          jupiter_request_id: string | null
          landed_without_submission_record: boolean
          last_valid_block_height: number | null
          not_landed_reason: string | null
          order_id: string
          quote_expires_at: string | null
          reconciliation_outcome: string | null
          reorg_detected_at: string | null
          router: string | null
          signed_at: string | null
          signed_tx_hash: string | null
          state: Database["enums"]["Enums"]["order_attempt_state"]
          submissions: Json
          submitted_at: string | null
          updated_at: string
          wallet_signature: string | null
        }
        Insert: {
          attempt_number: number
          authorization_hash?: string | null
          blockhash?: string | null
          confirmed_at?: string | null
          confirmed_slot?: number | null
          created_at?: string
          expected_tx_signature?: string | null
          finalized_at?: string | null
          finalized_slot?: number | null
          id?: string
          intent_id: string
          jupiter_request_id?: string | null
          landed_without_submission_record?: boolean
          last_valid_block_height?: number | null
          not_landed_reason?: string | null
          order_id: string
          quote_expires_at?: string | null
          reconciliation_outcome?: string | null
          reorg_detected_at?: string | null
          router?: string | null
          signed_at?: string | null
          signed_tx_hash?: string | null
          state?: Database["enums"]["Enums"]["order_attempt_state"]
          submissions?: Json
          submitted_at?: string | null
          updated_at?: string
          wallet_signature?: string | null
        }
        Update: {
          attempt_number?: number
          authorization_hash?: string | null
          blockhash?: string | null
          confirmed_at?: string | null
          confirmed_slot?: number | null
          created_at?: string
          expected_tx_signature?: string | null
          finalized_at?: string | null
          finalized_slot?: number | null
          id?: string
          intent_id?: string
          jupiter_request_id?: string | null
          landed_without_submission_record?: boolean
          last_valid_block_height?: number | null
          not_landed_reason?: string | null
          order_id?: string
          quote_expires_at?: string | null
          reconciliation_outcome?: string | null
          reorg_detected_at?: string | null
          router?: string | null
          signed_at?: string | null
          signed_tx_hash?: string | null
          state?: Database["enums"]["Enums"]["order_attempt_state"]
          submissions?: Json
          submitted_at?: string | null
          updated_at?: string
          wallet_signature?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "order_attempts_authorization_hash_fkey"
            columns: ["authorization_hash"]
            isOneToOne: false
            referencedRelation: "risk_authorizations"
            referencedColumns: ["authorization_hash"]
          },
          {
            foreignKeyName: "order_attempts_intent_id_fkey"
            columns: ["intent_id"]
            isOneToOne: false
            referencedRelation: "intents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_attempts_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          authorization_hash: string | null
          created_at: string
          execution_path: Database["enums"]["Enums"]["execution_path"]
          id: string
          intent_id: string
          transaction_class: Database["enums"]["Enums"]["transaction_class"]
        }
        Insert: {
          authorization_hash?: string | null
          created_at?: string
          execution_path: Database["enums"]["Enums"]["execution_path"]
          id?: string
          intent_id: string
          transaction_class: Database["enums"]["Enums"]["transaction_class"]
        }
        Update: {
          authorization_hash?: string | null
          created_at?: string
          execution_path?: Database["enums"]["Enums"]["execution_path"]
          id?: string
          intent_id?: string
          transaction_class?: Database["enums"]["Enums"]["transaction_class"]
        }
        Relationships: [
          {
            foreignKeyName: "orders_authorization_hash_fkey"
            columns: ["authorization_hash"]
            isOneToOne: false
            referencedRelation: "risk_authorizations"
            referencedColumns: ["authorization_hash"]
          },
          {
            foreignKeyName: "orders_intent_id_fkey"
            columns: ["intent_id"]
            isOneToOne: false
            referencedRelation: "intents"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolio_snapshots: {
        Row: {
          account_id: string
          as_of: string
          created_at: string
          drawdown: Json
          equity_base_units: number
          equity_usd: number | null
          exposure_base_units: number
          exposure_fraction: number
          id: string
          per_cohort: Json
          per_sleeve: Json
          settlement_mint: string
        }
        Insert: {
          account_id: string
          as_of: string
          created_at?: string
          drawdown: Json
          equity_base_units: number
          equity_usd?: number | null
          exposure_base_units: number
          exposure_fraction: number
          id?: string
          per_cohort?: Json
          per_sleeve?: Json
          settlement_mint: string
        }
        Update: {
          account_id?: string
          as_of?: string
          created_at?: string
          drawdown?: Json
          equity_base_units?: number
          equity_usd?: number | null
          exposure_base_units?: number
          exposure_fraction?: number
          id?: string
          per_cohort?: Json
          per_sleeve?: Json
          settlement_mint?: string
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_snapshots_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      position_lots: {
        Row: {
          asset_id: string
          closed_at: string | null
          cost_basis_base_units: number
          entry_fill_ids: string[]
          entry_intent_id: string
          exit_fill_ids: string[]
          id: string
          mint: string
          opened_at: string
          position_id: string
          protection_mode: Database["enums"]["Enums"]["protection_mode"]
          provider_order_id: string | null
          quantity: number
          realized_pnl_base_units: number
          reserved_for_protection: number
          sleeve_id: string
          status: string
          strategy_version_id: string
          updated_at: string
        }
        Insert: {
          asset_id: string
          closed_at?: string | null
          cost_basis_base_units: number
          entry_fill_ids?: string[]
          entry_intent_id: string
          exit_fill_ids?: string[]
          id?: string
          mint: string
          opened_at: string
          position_id: string
          protection_mode: Database["enums"]["Enums"]["protection_mode"]
          provider_order_id?: string | null
          quantity: number
          realized_pnl_base_units?: number
          reserved_for_protection?: number
          sleeve_id: string
          status?: string
          strategy_version_id: string
          updated_at?: string
        }
        Update: {
          asset_id?: string
          closed_at?: string | null
          cost_basis_base_units?: number
          entry_fill_ids?: string[]
          entry_intent_id?: string
          exit_fill_ids?: string[]
          id?: string
          mint?: string
          opened_at?: string
          position_id?: string
          protection_mode?: Database["enums"]["Enums"]["protection_mode"]
          provider_order_id?: string | null
          quantity?: number
          realized_pnl_base_units?: number
          reserved_for_protection?: number
          sleeve_id?: string
          status?: string
          strategy_version_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "position_lots_entry_intent_id_fkey"
            columns: ["entry_intent_id"]
            isOneToOne: false
            referencedRelation: "intents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "position_lots_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "position_lots_sleeve_id_fkey"
            columns: ["sleeve_id"]
            isOneToOne: false
            referencedRelation: "strategy_sleeves"
            referencedColumns: ["id"]
          },
        ]
      }
      position_safety_evaluations: {
        Row: {
          asset_id: string
          baseline: Json
          chain_slot: number
          created_at: string
          evaluated_at: string
          exit_compatibility: Json
          id: string
          liquidity_usd: number | null
          observed: Json
          policy_version: string
          position_id: string
          position_quantity: number
          previous_state:
            | Database["enums"]["Enums"]["position_safety_state"]
            | null
          reasons: unknown[]
          state: Database["enums"]["Enums"]["position_safety_state"]
          triggers: string[]
        }
        Insert: {
          asset_id: string
          baseline: Json
          chain_slot: number
          created_at?: string
          evaluated_at: string
          exit_compatibility: Json
          id?: string
          liquidity_usd?: number | null
          observed: Json
          policy_version: string
          position_id: string
          position_quantity: number
          previous_state?:
            | Database["enums"]["Enums"]["position_safety_state"]
            | null
          reasons?: unknown[]
          state: Database["enums"]["Enums"]["position_safety_state"]
          triggers: string[]
        }
        Update: {
          asset_id?: string
          baseline?: Json
          chain_slot?: number
          created_at?: string
          evaluated_at?: string
          exit_compatibility?: Json
          id?: string
          liquidity_usd?: number | null
          observed?: Json
          policy_version?: string
          position_id?: string
          position_quantity?: number
          previous_state?:
            | Database["enums"]["Enums"]["position_safety_state"]
            | null
          reasons?: unknown[]
          state?: Database["enums"]["Enums"]["position_safety_state"]
          triggers?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "position_safety_evaluations_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
        ]
      }
      position_shadow_journal: {
        Row: {
          account_id: string
          created_at: string
          hash: string
          id: string
          sequence: number
          shadow: Json
          synchronized_at: string | null
        }
        Insert: {
          account_id: string
          created_at?: string
          hash: string
          id?: string
          sequence: number
          shadow: Json
          synchronized_at?: string | null
        }
        Update: {
          account_id?: string
          created_at?: string
          hash?: string
          id?: string
          sequence?: number
          shadow?: Json
          synchronized_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "position_shadow_journal_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      positions: {
        Row: {
          account_id: string
          asset_id: string
          average_entry_price: number | null
          closed_at: string | null
          cost_basis_base_units: number
          custody_split: Json
          id: string
          last_reviewed_cycle_id: string | null
          mint: string
          next_reassessment_at: string | null
          opened_at: string
          quantity: number
          realized_pnl_base_units: number
          review_state: Database["enums"]["Enums"]["position_review_state"]
          review_state_reason:
            | Database["enums"]["Enums"]["unresolved_reason"]
            | null
          review_state_since: string
          safety_state: Database["enums"]["Enums"]["position_safety_state"]
          status: Database["enums"]["Enums"]["position_status"]
          stop: Json | null
          target: Json | null
          unrealized_pnl_base_units: number | null
          unreviewed_stop: number | null
          updated_at: string
        }
        Insert: {
          account_id: string
          asset_id: string
          average_entry_price?: number | null
          closed_at?: string | null
          cost_basis_base_units?: number
          custody_split?: Json
          id?: string
          last_reviewed_cycle_id?: string | null
          mint: string
          next_reassessment_at?: string | null
          opened_at: string
          quantity?: number
          realized_pnl_base_units?: number
          review_state?: Database["enums"]["Enums"]["position_review_state"]
          review_state_reason?:
            | Database["enums"]["Enums"]["unresolved_reason"]
            | null
          review_state_since: string
          safety_state?: Database["enums"]["Enums"]["position_safety_state"]
          status?: Database["enums"]["Enums"]["position_status"]
          stop?: Json | null
          target?: Json | null
          unrealized_pnl_base_units?: number | null
          unreviewed_stop?: number | null
          updated_at?: string
        }
        Update: {
          account_id?: string
          asset_id?: string
          average_entry_price?: number | null
          closed_at?: string | null
          cost_basis_base_units?: number
          custody_split?: Json
          id?: string
          last_reviewed_cycle_id?: string | null
          mint?: string
          next_reassessment_at?: string | null
          opened_at?: string
          quantity?: number
          realized_pnl_base_units?: number
          review_state?: Database["enums"]["Enums"]["position_review_state"]
          review_state_reason?:
            | Database["enums"]["Enums"]["unresolved_reason"]
            | null
          review_state_since?: string
          safety_state?: Database["enums"]["Enums"]["position_safety_state"]
          status?: Database["enums"]["Enums"]["position_status"]
          stop?: Json | null
          target?: Json | null
          unrealized_pnl_base_units?: number | null
          unreviewed_stop?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "positions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      proposals: {
        Row: {
          action_cycle_id: string
          candidate_id: string | null
          created_at: string
          expires_at: string
          id: string
          position_id: string | null
          proposal: Json
          source: Database["enums"]["Enums"]["proposal_source"]
          strategy_version_id: string
        }
        Insert: {
          action_cycle_id: string
          candidate_id?: string | null
          created_at: string
          expires_at: string
          id?: string
          position_id?: string | null
          proposal: Json
          source: Database["enums"]["Enums"]["proposal_source"]
          strategy_version_id: string
        }
        Update: {
          action_cycle_id?: string
          candidate_id?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          position_id?: string | null
          proposal?: Json
          source?: Database["enums"]["Enums"]["proposal_source"]
          strategy_version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "proposals_position_fk"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
        ]
      }
      reconciliation_cursors: {
        Row: {
          account_id: string
          last_reconciliation_id: string | null
          last_signature: string | null
          last_slot: number | null
          sol_lamports: number | null
          updated_at: string
        }
        Insert: {
          account_id: string
          last_reconciliation_id?: string | null
          last_signature?: string | null
          last_slot?: number | null
          sol_lamports?: number | null
          updated_at?: string
        }
        Update: {
          account_id?: string
          last_reconciliation_id?: string | null
          last_signature?: string | null
          last_slot?: number | null
          sol_lamports?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reconciliation_cursors_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: true
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reconciliation_cursors_last_reconciliation_id_fkey"
            columns: ["last_reconciliation_id"]
            isOneToOne: false
            referencedRelation: "custody_reconciliations"
            referencedColumns: ["id"]
          },
        ]
      }
      risk_authorizations: {
        Row: {
          authorization_hash: string
          created_at: string
          envelope: Json
          expires_at: string
          id: string
          intent_id: string
          key_id: string
          nonce: string
        }
        Insert: {
          authorization_hash: string
          created_at?: string
          envelope: Json
          expires_at: string
          id?: string
          intent_id: string
          key_id: string
          nonce: string
        }
        Update: {
          authorization_hash?: string
          created_at?: string
          envelope?: Json
          expires_at?: string
          id?: string
          intent_id?: string
          key_id?: string
          nonce?: string
        }
        Relationships: [
          {
            foreignKeyName: "risk_authorizations_intent_id_fkey"
            columns: ["intent_id"]
            isOneToOne: false
            referencedRelation: "intents"
            referencedColumns: ["id"]
          },
        ]
      }
      risk_evaluations: {
        Row: {
          action_cycle_id: string
          allowed: boolean
          asset_eligibility_evaluation_id: string | null
          circuit_breaker_tripped: boolean
          cluster_exposure: Json
          cohort_exposure: Json
          computed_max_loss_base_units: number | null
          computed_position_amount: number | null
          created_at: string
          daily_drawdown_fraction: number
          equity_base_units: number
          equity_usd: number | null
          exposure_base_units: number
          id: string
          max_price_impact_bps: number
          max_slippage_bps: number
          policy_version: string
          proposal_id: string
          reason_codes: unknown[]
          settlement_mint: string
          sleeve_exposure: number | null
          stale_data_checks: Json
          stop_policy: Json | null
          target_policy: Json | null
        }
        Insert: {
          action_cycle_id: string
          allowed: boolean
          asset_eligibility_evaluation_id?: string | null
          circuit_breaker_tripped: boolean
          cluster_exposure?: Json
          cohort_exposure?: Json
          computed_max_loss_base_units?: number | null
          computed_position_amount?: number | null
          created_at?: string
          daily_drawdown_fraction: number
          equity_base_units: number
          equity_usd?: number | null
          exposure_base_units: number
          id?: string
          max_price_impact_bps: number
          max_slippage_bps: number
          policy_version: string
          proposal_id: string
          reason_codes?: unknown[]
          settlement_mint: string
          sleeve_exposure?: number | null
          stale_data_checks?: Json
          stop_policy?: Json | null
          target_policy?: Json | null
        }
        Update: {
          action_cycle_id?: string
          allowed?: boolean
          asset_eligibility_evaluation_id?: string | null
          circuit_breaker_tripped?: boolean
          cluster_exposure?: Json
          cohort_exposure?: Json
          computed_max_loss_base_units?: number | null
          computed_position_amount?: number | null
          created_at?: string
          daily_drawdown_fraction?: number
          equity_base_units?: number
          equity_usd?: number | null
          exposure_base_units?: number
          id?: string
          max_price_impact_bps?: number
          max_slippage_bps?: number
          policy_version?: string
          proposal_id?: string
          reason_codes?: unknown[]
          settlement_mint?: string
          sleeve_exposure?: number | null
          stale_data_checks?: Json
          stop_policy?: Json | null
          target_policy?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "risk_evaluations_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      strategy_sleeves: {
        Row: {
          account_id: string
          active: boolean
          capital_cap_base_units: number
          committed_base_units: number
          created_at: string
          id: string
          risk_budget_base_units: number
          risk_used_base_units: number
          settlement_mint: string
          strategy_version_id: string
          version_id: string
        }
        Insert: {
          account_id: string
          active?: boolean
          capital_cap_base_units: number
          committed_base_units?: number
          created_at?: string
          id?: string
          risk_budget_base_units: number
          risk_used_base_units?: number
          settlement_mint: string
          strategy_version_id: string
          version_id: string
        }
        Update: {
          account_id?: string
          active?: boolean
          capital_cap_base_units?: number
          committed_base_units?: number
          created_at?: string
          id?: string
          risk_budget_base_units?: number
          risk_used_base_units?: number
          settlement_mint?: string
          strategy_version_id?: string
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "strategy_sleeves_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      record_position_safety: { Args: { p_evaluation: Json }; Returns: string }
      record_reconciliation: { Args: { p_report: Json }; Returns: string }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  agents: {
    Enums: {},
  },
  audit: {
    Enums: {},
  },
  core: {
    Enums: {},
  },
  enums: {
    Enums: {
      account_mode: ["LIVE", "PAPER"],
      action_cycle_state: [
        "TRIGGERED",
        "CONTEXT_BUILT",
        "PROPOSED",
        "REVISION_REQUESTED",
        "CLEARED",
        "REJECTED",
        "EXPIRED",
        "UNRESOLVED",
      ],
      activity_state: [
        "OFF",
        "STARTING",
        "WATCH",
        "ACTIVE",
        "EVENT_WINDOW",
        "WIND_DOWN",
      ],
      actor_kind: [
        "OPERATOR",
        "WORKER",
        "RISK_AUTHORIZER",
        "EXECUTOR",
        "OUT_OF_BAND_KEY",
        "AUTOMATION",
        "WATCHDOG",
        "SCHEDULE",
      ],
      adversary_verdict: ["CONFIRM", "CHALLENGE", "REJECT"],
      agent_role: [
        "TRADING_PROPOSER",
        "ACTION_ADVERSARY",
        "EVENT_CLASSIFIER",
        "SUMMARIZER",
      ],
      alert_severity: ["INFO", "NOTICE", "HIGH", "CRITICAL"],
      asset_status: [
        "DISCOVERED",
        "EVALUATING",
        "ELIGIBLE",
        "BLOCKED",
        "RETIRED",
      ],
      audit_origin: ["NORMAL", "EMERGENCY_JOURNAL_IMPORT", "WATCHDOG"],
      authority_state: ["NONE", "PRESENT", "UNKNOWN"],
      automation_trigger_family: ["CANDIDATE", "OPEN_POSITION", "SYSTEM"],
      candidate_status: [
        "DETECTED",
        "ENRICHING",
        "REJECTED",
        "AGENT_REVIEW",
        "QUALIFIED",
        "EXPIRED",
      ],
      candle_resolution: ["15s", "1m", "5m", "15m", "1h", "4h"],
      capital_authority: ["OBSERVE", "PAPER", "LIVE_APPROVAL", "LIVE_AUTO"],
      chain_commitment: ["processed", "confirmed", "finalized"],
      control_request_kind: [
        "SET_REQUESTED_MODE",
        "PAUSE_NEW_ENTRIES",
        "RESUME_NEW_ENTRIES",
        "APPROVE_AUTHORIZATION",
        "REJECT_AUTHORIZATION",
        "MANUAL_REDUCE",
        "MANUAL_CLOSE",
        "EMERGENCY_CLOSE_ALL",
        "ACKNOWLEDGE_ALERT",
        "PROMOTE_RELEASE",
        "ARM_RELEASE",
        "RUN_READINESS_DRILL",
        "START_SESSION",
        "END_SESSION",
        "REGISTER_PASSKEY",
        "REVOKE_PASSKEY",
      ],
      control_request_state: ["PENDING", "ACCEPTED", "REJECTED", "EXPIRED"],
      custody_kind: [
        "TRADING_WALLET",
        "ASSOCIATED_TOKEN_ACCOUNT",
        "JUPITER_TRIGGER_VAULT",
        "APPROVED_OTHER",
      ],
      data_provenance: ["LIVE", "BACKFILL", "REPLAY"],
      deployment_profile: ["P0", "P1A", "P1B", "P2", "P3", "P4"],
      emergency_command_type: [
        "PAUSE_NEW_ENTRIES",
        "EMERGENCY_CLOSE_ASSET",
        "EMERGENCY_CLOSE_ALL",
      ],
      event_kind: [
        "NEWS",
        "SOCIAL",
        "ONCHAIN",
        "PROJECT",
        "MACRO",
        "LISTING",
        "SECURITY",
        "OTHER",
      ],
      execution_path: [
        "JUPITER_ORDER",
        "PROVIDER_PROTECTIVE",
        "DIRECT_POOL_PRIVATE",
        "DIRECT_POOL_RPC",
      ],
      exposure_effect: ["INCREASE", "NEUTRAL", "REDUCE"],
      funding_event_state: [
        "PREPARED",
        "WALLET_PROMPTED",
        "SUBMITTED",
        "CONFIRMED",
        "FAILED",
        "ABANDONED",
      ],
      intent_action: [
        "ENTER",
        "ADD",
        "REDUCE",
        "EXIT",
        "PROTECTION_INSTALL",
        "PROTECTION_CANCEL_WITHDRAW",
        "EMERGENCY_CLOSE",
      ],
      market_regime: [
        "RISK_ON_TREND",
        "BROAD_SELLOFF",
        "SOL_LED_RALLY",
        "NARRATIVE_ROTATION",
        "LOW_LIQUIDITY_CHOP",
        "VOLATILITY_SHOCK",
        "POST_EVENT_INSTABILITY",
      ],
      market_session: [
        "ASIA",
        "EUROPE",
        "US",
        "ASIA_EUROPE_OVERLAP",
        "EUROPE_US_OVERLAP",
        "WEEKEND",
      ],
      notification_channel: ["IN_APP", "PUSH", "TELEGRAM", "SMS", "EMAIL"],
      operator_role: ["viewer", "operator", "admin"],
      order_attempt_state: [
        "PREPARED",
        "SIGNED_NOT_SUBMITTED",
        "SUBMITTED",
        "CONFIRMED_PROVISIONAL",
        "FINALIZED",
        "REORG_PENDING",
        "NOT_LANDED",
      ],
      position_review_state: ["REVIEWED", "PROTECTION_ONLY", "BUDGET_PAUSED"],
      position_safety_state: [
        "NORMAL",
        "DEGRADED",
        "EXIT_RECOMMENDED",
        "CRITICAL_EXIT",
      ],
      position_status: ["OPEN", "CLOSING", "CLOSED"],
      proposal_source: ["AI", "DETERMINISTIC"],
      protection_mode: ["MONITORED_EXIT", "JUPITER_TRIGGER"],
      provider_health: ["HEALTHY", "DEGRADED", "FAILED"],
      release_status: [
        "DRAFT",
        "PAPER_VALIDATED",
        "ELIGIBLE_LIVE",
        "ARMED",
        "RETIRED",
      ],
      skill_status: ["DRAFT", "PAPER", "ELIGIBLE_LIVE", "RETIRED"],
      solana_cluster: ["mainnet-beta", "devnet", "testnet", "localnet"],
      source_quality_class: [
        "OFFICIAL_PROJECT",
        "OFFICIAL_EXCHANGE_PROTOCOL",
        "PRIMARY_GOVERNMENT_REGULATORY",
        "REPUTABLE_PUBLICATION",
        "ANALYTICS_PROVIDER",
        "IDENTIFIED_CREATOR",
        "UNKNOWN_SOCIAL",
      ],
      source_time_confidence: ["HIGH", "MEDIUM", "LOW", "ABSENT"],
      speed_tier: ["T0_FAST", "T1_MOMENTUM", "T2_CONTEXTUAL", "T3_CATALYST"],
      stop_model: [
        "ATR",
        "STRUCTURE_LOW",
        "PERCENTAGE",
        "STRATEGY_INVALIDATION",
      ],
      strategy_id: ["S0_RAW", "S0_SAFE", "S1", "S2", "S3", "S4"],
      strategy_status: ["EXPERIMENTAL", "PAPER", "ELIGIBLE_LIVE", "RETIRED"],
      take_profit_policy: [
        "FIXED_R",
        "PARTIAL_TIERS",
        "TRAILING_AFTER_THRESHOLD",
        "VOLATILITY_TRAIL",
        "MOMENTUM_DECAY",
        "TIME_STOP",
      ],
      token_program: ["TOKEN", "TOKEN_2022", "UNKNOWN"],
      tool_classification: ["READ_ONLY", "PROPOSAL_ONLY"],
      trade_side: ["BUY", "SELL"],
      trading_action_type: [
        "ENTER",
        "IGNORE",
        "HOLD",
        "REDUCE",
        "EXIT",
        "ADJUST_PROTECTION",
        "ADD",
      ],
      transaction_class: [
        "SWAP_V2",
        "TRIGGER_DEPOSIT",
        "TRIGGER_CANCEL_WITHDRAW",
        "TRIGGER_AUTH_CHALLENGE",
        "DIRECT_POOL_EMERGENCY_EXIT",
        "SWEEP_TO_COLD_RECOVERY",
      ],
      trigger_family: [
        "MOMENTUM_CONTINUATION",
        "EARLY_ACCELERATION",
        "SMART_MONEY_ACCUMULATION",
        "CATALYST_RESPONSE",
        "SOCIAL_ACCELERATION",
        "HOLDER_LIQUIDITY_EXPANSION",
        "MANUAL_WATCH",
      ],
      unresolved_reason: [
        "DISAGREEMENT",
        "ADVERSARY_UNAVAILABLE",
        "TIMEOUT",
        "BUDGET",
        "MALFORMED_OUTPUT",
        "REVISION_EXHAUSTED",
      ],
      wallet_classification: [
        "SMART_MONEY",
        "WHALE",
        "DEV",
        "INSIDER",
        "SNIPER",
        "BUNDLER",
        "EXCHANGE",
        "TREASURY",
        "OWNED",
        "UNKNOWN",
      ],
    },
  },
  intelligence: {
    Enums: {},
  },
  market: {
    Enums: {},
  },
  ops: {
    Enums: {},
  },
  research: {
    Enums: {},
  },
  risk: {
    Enums: {},
  },
  signals: {
    Enums: {},
  },
  trading: {
    Enums: {},
  },
} as const

