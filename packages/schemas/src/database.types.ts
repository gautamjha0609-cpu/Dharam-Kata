export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          actor_role: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          id: string
          meta: Json
          organization_id: string | null
          reason: string | null
          request_id: string | null
          site_id: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_role?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          meta?: Json
          organization_id?: string | null
          reason?: string | null
          request_id?: string | null
          site_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_role?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          meta?: Json
          organization_id?: string | null
          reason?: string | null
          request_id?: string | null
          site_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_payments: {
        Row: {
          amount: number
          id: string
          invoice_id: string
          kind: string
          method: string
          occurred_at: string
          organization_id: string
          party_id: string | null
          reason: string | null
          recorded_at: string
          recorded_by: string
          reference: string | null
          site_id: string
        }
        Insert: {
          amount: number
          id?: string
          invoice_id: string
          kind: string
          method?: string
          occurred_at?: string
          organization_id: string
          party_id?: string | null
          reason?: string | null
          recorded_at?: string
          recorded_by: string
          reference?: string | null
          site_id: string
        }
        Update: {
          amount?: number
          id?: string
          invoice_id?: string
          kind?: string
          method?: string
          occurred_at?: string
          organization_id?: string
          party_id?: string | null
          reason?: string | null
          recorded_at?: string
          recorded_by?: string
          reference?: string | null
          site_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_payments_invoice_id_organization_id_fkey"
            columns: ["invoice_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "invoice_balances"
            referencedColumns: ["invoice_id", "organization_id"]
          },
          {
            foreignKeyName: "invoice_payments_invoice_id_organization_id_fkey"
            columns: ["invoice_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      invoice_series: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          id: string
          next_number: number
          organization_id: string
          padding_width: number
          period_key: string
          prefix: string
          reset_policy: Database["public"]["Enums"]["series_reset"]
          site_id: string | null
          start_number: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          next_number: number
          organization_id: string
          padding_width?: number
          period_key?: string
          prefix?: string
          reset_policy?: Database["public"]["Enums"]["series_reset"]
          site_id?: string | null
          start_number: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          next_number?: number
          organization_id?: string
          padding_width?: number
          period_key?: string
          prefix?: string
          reset_policy?: Database["public"]["Enums"]["series_reset"]
          site_id?: string | null
          start_number?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoice_series_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_series_site_id_organization_id_fkey"
            columns: ["site_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      invoices: {
        Row: {
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          created_at: string
          currency: string
          fee_total: number
          gross_weight_at: string
          gross_weight_kg: number
          id: string
          idempotency_key: string
          invoice_number: string
          issued_at: string
          issued_by: string
          material: string | null
          net_weight_kg: number
          notes: string | null
          organization_id: string
          party_id: string | null
          party_name: string | null
          party_snapshot: Json
          payment_mode: Database["public"]["Enums"]["payment_mode"]
          period_key: string
          quantity: number
          rate: number
          seq_value: number
          series_id: string
          site_id: string
          status: Database["public"]["Enums"]["invoice_status"]
          tare_weight_at: string
          tare_weight_kg: number
          vehicle_display: string
          weighment_id: string
          weight_unit: Database["public"]["Enums"]["weight_unit"]
        }
        Insert: {
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          currency?: string
          fee_total: number
          gross_weight_at: string
          gross_weight_kg: number
          id?: string
          idempotency_key: string
          invoice_number: string
          issued_at?: string
          issued_by: string
          material?: string | null
          net_weight_kg: number
          notes?: string | null
          organization_id: string
          party_id?: string | null
          party_name?: string | null
          party_snapshot?: Json
          payment_mode: Database["public"]["Enums"]["payment_mode"]
          period_key?: string
          quantity: number
          rate: number
          seq_value: number
          series_id: string
          site_id: string
          status?: Database["public"]["Enums"]["invoice_status"]
          tare_weight_at: string
          tare_weight_kg: number
          vehicle_display: string
          weighment_id: string
          weight_unit: Database["public"]["Enums"]["weight_unit"]
        }
        Update: {
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          currency?: string
          fee_total?: number
          gross_weight_at?: string
          gross_weight_kg?: number
          id?: string
          idempotency_key?: string
          invoice_number?: string
          issued_at?: string
          issued_by?: string
          material?: string | null
          net_weight_kg?: number
          notes?: string | null
          organization_id?: string
          party_id?: string | null
          party_name?: string | null
          party_snapshot?: Json
          payment_mode?: Database["public"]["Enums"]["payment_mode"]
          period_key?: string
          quantity?: number
          rate?: number
          seq_value?: number
          series_id?: string
          site_id?: string
          status?: Database["public"]["Enums"]["invoice_status"]
          tare_weight_at?: string
          tare_weight_kg?: number
          vehicle_display?: string
          weighment_id?: string
          weight_unit?: Database["public"]["Enums"]["weight_unit"]
        }
        Relationships: [
          {
            foreignKeyName: "invoices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_party_id_organization_id_fkey"
            columns: ["party_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "parties"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "invoices_series_id_organization_id_fkey"
            columns: ["series_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "invoice_series"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "invoices_site_id_organization_id_fkey"
            columns: ["site_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "invoices_weighment_id_organization_id_fkey"
            columns: ["weighment_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "weighments"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      organization_memberships: {
        Row: {
          id: string
          invited_by: string | null
          joined_at: string
          organization_id: string
          permissions: string[]
          role: Database["public"]["Enums"]["org_role"]
          status: Database["public"]["Enums"]["member_status"]
          user_id: string
        }
        Insert: {
          id?: string
          invited_by?: string | null
          joined_at?: string
          organization_id: string
          permissions?: string[]
          role: Database["public"]["Enums"]["org_role"]
          status?: Database["public"]["Enums"]["member_status"]
          user_id: string
        }
        Update: {
          id?: string
          invited_by?: string | null
          joined_at?: string
          organization_id?: string
          permissions?: string[]
          role?: Database["public"]["Enums"]["org_role"]
          status?: Database["public"]["Enums"]["member_status"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_memberships_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          currency: string
          display_name: string
          id: string
          legal_name: string
          plan_code: string
          settings: Json
          settings_version: number
          slug: string
          status: Database["public"]["Enums"]["org_status"]
          suspended_at: string | null
          suspension_reason: string | null
          timezone: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string
          display_name: string
          id?: string
          legal_name: string
          plan_code?: string
          settings?: Json
          settings_version?: number
          slug: string
          status?: Database["public"]["Enums"]["org_status"]
          suspended_at?: string | null
          suspension_reason?: string | null
          timezone?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string
          display_name?: string
          id?: string
          legal_name?: string
          plan_code?: string
          settings?: Json
          settings_version?: number
          slug?: string
          status?: Database["public"]["Enums"]["org_status"]
          suspended_at?: string | null
          suspension_reason?: string | null
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      pairing_codes: {
        Row: {
          code_hash: string
          created_at: string
          created_by: string
          expires_at: string
          id: string
          organization_id: string
          site_id: string
          used_at: string | null
        }
        Insert: {
          code_hash: string
          created_at?: string
          created_by: string
          expires_at: string
          id?: string
          organization_id: string
          site_id: string
          used_at?: string | null
        }
        Update: {
          code_hash?: string
          created_at?: string
          created_by?: string
          expires_at?: string
          id?: string
          organization_id?: string
          site_id?: string
          used_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pairing_codes_site_id_organization_id_fkey"
            columns: ["site_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      parties: {
        Row: {
          active: boolean
          address: string | null
          city: string | null
          contact_person: string | null
          created_at: string
          created_by: string | null
          display_name: string
          email: string | null
          gstin: string | null
          id: string
          normalized_name: string
          organization_id: string
          pan: string | null
          party_code: string | null
          party_type: Database["public"]["Enums"]["party_type"]
          phone: string | null
          pin: string | null
          state: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          address?: string | null
          city?: string | null
          contact_person?: string | null
          created_at?: string
          created_by?: string | null
          display_name: string
          email?: string | null
          gstin?: string | null
          id?: string
          normalized_name: string
          organization_id: string
          pan?: string | null
          party_code?: string | null
          party_type?: Database["public"]["Enums"]["party_type"]
          phone?: string | null
          pin?: string | null
          state?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          address?: string | null
          city?: string | null
          contact_person?: string | null
          created_at?: string
          created_by?: string | null
          display_name?: string
          email?: string | null
          gstin?: string | null
          id?: string
          normalized_name?: string
          organization_id?: string
          pan?: string | null
          party_code?: string | null
          party_type?: Database["public"]["Enums"]["party_type"]
          phone?: string | null
          pin?: string | null
          state?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "parties_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_admins: {
        Row: {
          active: boolean
          granted_at: string
          platform_role: Database["public"]["Enums"]["platform_role"]
          revoked_at: string | null
          user_id: string
        }
        Insert: {
          active?: boolean
          granted_at?: string
          platform_role: Database["public"]["Enums"]["platform_role"]
          revoked_at?: string | null
          user_id: string
        }
        Update: {
          active?: boolean
          granted_at?: string
          platform_role?: Database["public"]["Enums"]["platform_role"]
          revoked_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      pricing_settings: {
        Row: {
          default_rate: number | null
          organization_id: string
          updated_at: string
          updated_by: string | null
          weight_unit: Database["public"]["Enums"]["weight_unit"] | null
        }
        Insert: {
          default_rate?: number | null
          organization_id: string
          updated_at?: string
          updated_by?: string | null
          weight_unit?: Database["public"]["Enums"]["weight_unit"] | null
        }
        Update: {
          default_rate?: number | null
          organization_id?: string
          updated_at?: string
          updated_by?: string | null
          weight_unit?: Database["public"]["Enums"]["weight_unit"] | null
        }
        Relationships: [
          {
            foreignKeyName: "pricing_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      print_agents: {
        Row: {
          app_version: string | null
          created_at: string
          created_by: string | null
          credential_hash: string
          id: string
          label: string
          last_heartbeat_at: string | null
          organization_id: string
          os: string | null
          printers_seen: Json
          revoked_at: string | null
          site_id: string
          status: Database["public"]["Enums"]["agent_status"]
        }
        Insert: {
          app_version?: string | null
          created_at?: string
          created_by?: string | null
          credential_hash: string
          id?: string
          label: string
          last_heartbeat_at?: string | null
          organization_id: string
          os?: string | null
          printers_seen?: Json
          revoked_at?: string | null
          site_id: string
          status?: Database["public"]["Enums"]["agent_status"]
        }
        Update: {
          app_version?: string | null
          created_at?: string
          created_by?: string | null
          credential_hash?: string
          id?: string
          label?: string
          last_heartbeat_at?: string | null
          organization_id?: string
          os?: string | null
          printers_seen?: Json
          revoked_at?: string | null
          site_id?: string
          status?: Database["public"]["Enums"]["agent_status"]
        }
        Relationships: [
          {
            foreignKeyName: "print_agents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "print_agents_site_id_organization_id_fkey"
            columns: ["site_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      print_destinations: {
        Row: {
          active: boolean
          created_at: string
          id: string
          is_default: boolean
          organization_id: string
          origin_site_id: string
          printer_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          is_default?: boolean
          organization_id: string
          origin_site_id: string
          printer_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          is_default?: boolean
          organization_id?: string
          origin_site_id?: string
          printer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "print_destinations_origin_site_id_organization_id_fkey"
            columns: ["origin_site_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "print_destinations_printer_id_organization_id_fkey"
            columns: ["printer_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "printer_devices"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      print_job_events: {
        Row: {
          actor_agent_id: string | null
          actor_user_id: string | null
          attempt: number | null
          created_at: string
          error_code: string | null
          id: string
          job_id: string
          organization_id: string
          status: Database["public"]["Enums"]["print_status"]
        }
        Insert: {
          actor_agent_id?: string | null
          actor_user_id?: string | null
          attempt?: number | null
          created_at?: string
          error_code?: string | null
          id?: string
          job_id: string
          organization_id: string
          status: Database["public"]["Enums"]["print_status"]
        }
        Update: {
          actor_agent_id?: string | null
          actor_user_id?: string | null
          attempt?: number | null
          created_at?: string
          error_code?: string | null
          id?: string
          job_id?: string
          organization_id?: string
          status?: Database["public"]["Enums"]["print_status"]
        }
        Relationships: [
          {
            foreignKeyName: "print_job_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "print_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      print_jobs: {
        Row: {
          agent_id: string | null
          attempt_count: number
          claimed_at: string | null
          created_at: string
          destination_site_id: string | null
          id: string
          idempotency_key: string
          invoice_id: string
          job_type: Database["public"]["Enums"]["print_job_type"]
          last_error_code: string | null
          lease_expires_at: string | null
          lease_token: string | null
          organization_id: string
          origin_site_id: string
          payload: Json
          printer_id: string | null
          queued_at: string
          reported_at: string | null
          reprint_reason: string | null
          requested_by: string | null
          status: Database["public"]["Enums"]["print_status"]
          submitted_at: string | null
          template_snapshot: Json | null
          template_version_id: string | null
          updated_at: string
        }
        Insert: {
          agent_id?: string | null
          attempt_count?: number
          claimed_at?: string | null
          created_at?: string
          destination_site_id?: string | null
          id?: string
          idempotency_key: string
          invoice_id: string
          job_type?: Database["public"]["Enums"]["print_job_type"]
          last_error_code?: string | null
          lease_expires_at?: string | null
          lease_token?: string | null
          organization_id: string
          origin_site_id: string
          payload: Json
          printer_id?: string | null
          queued_at?: string
          reported_at?: string | null
          reprint_reason?: string | null
          requested_by?: string | null
          status?: Database["public"]["Enums"]["print_status"]
          submitted_at?: string | null
          template_snapshot?: Json | null
          template_version_id?: string | null
          updated_at?: string
        }
        Update: {
          agent_id?: string | null
          attempt_count?: number
          claimed_at?: string | null
          created_at?: string
          destination_site_id?: string | null
          id?: string
          idempotency_key?: string
          invoice_id?: string
          job_type?: Database["public"]["Enums"]["print_job_type"]
          last_error_code?: string | null
          lease_expires_at?: string | null
          lease_token?: string | null
          organization_id?: string
          origin_site_id?: string
          payload?: Json
          printer_id?: string | null
          queued_at?: string
          reported_at?: string | null
          reprint_reason?: string | null
          requested_by?: string | null
          status?: Database["public"]["Enums"]["print_status"]
          submitted_at?: string | null
          template_snapshot?: Json | null
          template_version_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "print_jobs_agent_id_organization_id_fkey"
            columns: ["agent_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "print_agents"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "print_jobs_invoice_id_organization_id_fkey"
            columns: ["invoice_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "invoice_balances"
            referencedColumns: ["invoice_id", "organization_id"]
          },
          {
            foreignKeyName: "print_jobs_invoice_id_organization_id_fkey"
            columns: ["invoice_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "print_jobs_origin_site_id_organization_id_fkey"
            columns: ["origin_site_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "print_jobs_printer_id_organization_id_fkey"
            columns: ["printer_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "printer_devices"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      printer_devices: {
        Row: {
          active: boolean
          agent_id: string
          created_at: string
          id: string
          label: string
          last_test_at: string | null
          offset_x_mm: number
          offset_y_mm: number
          organization_id: string
          os_printer_name: string
          paper_h_mm: number
          paper_w_mm: number
          site_id: string
        }
        Insert: {
          active?: boolean
          agent_id: string
          created_at?: string
          id?: string
          label: string
          last_test_at?: string | null
          offset_x_mm?: number
          offset_y_mm?: number
          organization_id: string
          os_printer_name: string
          paper_h_mm?: number
          paper_w_mm?: number
          site_id: string
        }
        Update: {
          active?: boolean
          agent_id?: string
          created_at?: string
          id?: string
          label?: string
          last_test_at?: string | null
          offset_x_mm?: number
          offset_y_mm?: number
          organization_id?: string
          os_printer_name?: string
          paper_h_mm?: number
          paper_w_mm?: number
          site_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "printer_devices_agent_id_organization_id_fkey"
            columns: ["agent_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "print_agents"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "printer_devices_site_id_organization_id_fkey"
            columns: ["site_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      profiles: {
        Row: {
          active: boolean
          created_at: string
          full_name: string
          login_id: string
          must_change_password: boolean
          phone: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          full_name?: string
          login_id: string
          must_change_password?: boolean
          phone?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          full_name?: string
          login_id?: string
          must_change_password?: boolean
          phone?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      receipt_template_versions: {
        Row: {
          checksum: string
          id: string
          layout: Json
          organization_id: string
          published_at: string
          published_by: string
          template_id: string
          version_no: number
        }
        Insert: {
          checksum: string
          id?: string
          layout: Json
          organization_id: string
          published_at?: string
          published_by: string
          template_id: string
          version_no: number
        }
        Update: {
          checksum?: string
          id?: string
          layout?: Json
          organization_id?: string
          published_at?: string
          published_by?: string
          template_id?: string
          version_no?: number
        }
        Relationships: [
          {
            foreignKeyName: "receipt_template_versions_template_id_organization_id_fkey"
            columns: ["template_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "receipt_templates"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      receipt_templates: {
        Row: {
          created_at: string
          draft_layout: Json
          id: string
          name: string
          organization_id: string
          printer_id: string | null
          published_version_id: string | null
          scope: Database["public"]["Enums"]["template_scope"]
          site_id: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          draft_layout: Json
          id?: string
          name: string
          organization_id: string
          printer_id?: string | null
          published_version_id?: string | null
          scope?: Database["public"]["Enums"]["template_scope"]
          site_id?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          draft_layout?: Json
          id?: string
          name?: string
          organization_id?: string
          printer_id?: string | null
          published_version_id?: string | null
          scope?: Database["public"]["Enums"]["template_scope"]
          site_id?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "receipt_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receipt_templates_printer_id_organization_id_fkey"
            columns: ["printer_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "printer_devices"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "receipt_templates_site_id_organization_id_fkey"
            columns: ["site_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      site_memberships: {
        Row: {
          active: boolean
          created_at: string
          organization_id: string
          site_id: string
          user_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          organization_id: string
          site_id: string
          user_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          organization_id?: string
          site_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "site_memberships_organization_id_user_id_fkey"
            columns: ["organization_id", "user_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "site_memberships_site_id_organization_id_fkey"
            columns: ["site_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      sites: {
        Row: {
          active: boolean
          address: string | null
          code: string
          created_at: string
          id: string
          name: string
          organization_id: string
          timezone: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          address?: string | null
          code: string
          created_at?: string
          id?: string
          name: string
          organization_id: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          address?: string | null
          code?: string
          created_at?: string
          id?: string
          name?: string
          organization_id?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sites_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      weighments: {
        Row: {
          created_at: string
          gross_entered_by: string
          gross_manual_reason: string | null
          gross_recorded_at: string
          gross_time_mode: Database["public"]["Enums"]["time_mode"]
          gross_weight_at: string
          gross_weight_kg: number
          id: string
          idempotency_key: string
          material: string | null
          net_weight_kg: number | null
          notes: string | null
          organization_id: string
          party_id: string | null
          site_id: string
          status: Database["public"]["Enums"]["weighment_status"]
          tare_entered_by: string | null
          tare_manual_reason: string | null
          tare_recorded_at: string | null
          tare_time_mode: Database["public"]["Enums"]["time_mode"] | null
          tare_weight_at: string | null
          tare_weight_kg: number | null
          updated_at: string
          vehicle_display: string
          vehicle_normalized: string
          version: number
        }
        Insert: {
          created_at?: string
          gross_entered_by: string
          gross_manual_reason?: string | null
          gross_recorded_at?: string
          gross_time_mode?: Database["public"]["Enums"]["time_mode"]
          gross_weight_at: string
          gross_weight_kg: number
          id?: string
          idempotency_key: string
          material?: string | null
          net_weight_kg?: number | null
          notes?: string | null
          organization_id: string
          party_id?: string | null
          site_id: string
          status?: Database["public"]["Enums"]["weighment_status"]
          tare_entered_by?: string | null
          tare_manual_reason?: string | null
          tare_recorded_at?: string | null
          tare_time_mode?: Database["public"]["Enums"]["time_mode"] | null
          tare_weight_at?: string | null
          tare_weight_kg?: number | null
          updated_at?: string
          vehicle_display: string
          vehicle_normalized: string
          version?: number
        }
        Update: {
          created_at?: string
          gross_entered_by?: string
          gross_manual_reason?: string | null
          gross_recorded_at?: string
          gross_time_mode?: Database["public"]["Enums"]["time_mode"]
          gross_weight_at?: string
          gross_weight_kg?: number
          id?: string
          idempotency_key?: string
          material?: string | null
          net_weight_kg?: number | null
          notes?: string | null
          organization_id?: string
          party_id?: string | null
          site_id?: string
          status?: Database["public"]["Enums"]["weighment_status"]
          tare_entered_by?: string | null
          tare_manual_reason?: string | null
          tare_recorded_at?: string | null
          tare_time_mode?: Database["public"]["Enums"]["time_mode"] | null
          tare_weight_at?: string | null
          tare_weight_kg?: number | null
          updated_at?: string
          vehicle_display?: string
          vehicle_normalized?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "weighments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weighments_party_id_organization_id_fkey"
            columns: ["party_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "parties"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "weighments_site_id_organization_id_fkey"
            columns: ["site_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
    }
    Views: {
      invoice_balances: {
        Row: {
          amount_paid: number | null
          fee_total: number | null
          invoice_id: string | null
          organization_id: string | null
          outstanding: number | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      agent_authenticate: { Args: { p_token: string }; Returns: string }
      agent_claim_job: { Args: { p_agent: string }; Returns: Json }
      agent_heartbeat: {
        Args: {
          p_agent: string
          p_os: string
          p_printers: Json
          p_version: string
        }
        Returns: undefined
      }
      agent_pair: {
        Args: { p_code: string; p_label: string; p_os: string }
        Returns: Record<string, unknown>
      }
      agent_record_event: {
        Args: {
          p_agent: string
          p_error?: string
          p_job: string
          p_lease: string
          p_status: Database["public"]["Enums"]["print_status"]
        }
        Returns: undefined
      }
      allocate_invoice_number: {
        Args: { p_at: string; p_org: string; p_site: string }
        Returns: Record<string, unknown>
      }
      assert_can: {
        Args: { p_org: string; p_perm: string; p_site?: string }
        Returns: undefined
      }
      bind_printer: {
        Args: {
          p_agent: string
          p_h: number
          p_label: string
          p_org: string
          p_os_name: string
          p_set_default_route?: boolean
          p_w: number
        }
        Returns: Json
      }
      build_print_values: {
        Args: { inv: Database["public"]["Tables"]["invoices"]["Row"] }
        Returns: Json
      }
      cancel_invoice: {
        Args: { p_invoice: string; p_org: string; p_reason: string }
        Returns: Json
      }
      complete_empty_weighment: {
        Args: {
          p_at: string
          p_expected_version: number
          p_org: string
          p_reason: string
          p_tare: number
          p_time_mode: Database["public"]["Enums"]["time_mode"]
          p_weighment: string
        }
        Returns: Json
      }
      complete_password_change: { Args: never; Returns: undefined }
      create_loaded_weighment: {
        Args: {
          p_at: string
          p_gross: number
          p_idem: string
          p_material: string
          p_notes: string
          p_org: string
          p_party: string
          p_reason: string
          p_site: string
          p_time_mode: Database["public"]["Enums"]["time_mode"]
          p_vehicle: string
        }
        Returns: Json
      }
      create_pairing_code: {
        Args: { p_org: string; p_site: string }
        Returns: Json
      }
      enqueue_print_job: {
        Args: {
          inv: Database["public"]["Tables"]["invoices"]["Row"]
          p_by: string
          p_idem: string
          p_reason: string
          p_type: Database["public"]["Enums"]["print_job_type"]
        }
        Returns: string
      }
      finalize_invoice: {
        Args: {
          p_amount_paid: number
          p_idem: string
          p_notes: string
          p_org: string
          p_party: string
          p_payment_mode: Database["public"]["Enums"]["payment_mode"]
          p_rate: number
          p_weighment: string
        }
        Returns: Json
      }
      has_permission: { Args: { org: string; perm: string }; Returns: boolean }
      has_site_access: { Args: { org: string; site: string }; Returns: boolean }
      initialize_invoice_series: {
        Args: {
          p_org: string
          p_padding: number
          p_prefix: string
          p_reset?: Database["public"]["Enums"]["series_reset"]
          p_site: string
          p_start: number
        }
        Returns: Json
      }
      is_org_member: { Args: { org: string }; Returns: boolean }
      is_platform_admin: {
        Args: { roles?: Database["public"]["Enums"]["platform_role"][] }
        Returns: boolean
      }
      me: { Args: never; Returns: Json }
      org_is_writable: { Args: { org: string }; Returns: boolean }
      post_collection: {
        Args: {
          p_amount: number
          p_invoice: string
          p_method: string
          p_occurred_at: string
          p_org: string
          p_reference: string
        }
        Returns: Json
      }
      publish_template: {
        Args: { p_org: string; p_template: string }
        Returns: Json
      }
      reprint_invoice: {
        Args: { p_invoice: string; p_org: string; p_reason: string }
        Returns: string
      }
      resolve_template: {
        Args: { p_org: string; p_printer: string; p_site: string }
        Returns: Record<string, unknown>
      }
      resolve_time: {
        Args: {
          p_at: string
          p_mode: Database["public"]["Enums"]["time_mode"]
          p_org: string
          p_reason: string
        }
        Returns: string
      }
      revert_template: {
        Args: { p_org: string; p_template: string; p_version: number }
        Returns: undefined
      }
      revoke_agent: {
        Args: { p_agent: string; p_org: string }
        Returns: undefined
      }
      role_permissions: {
        Args: { r: Database["public"]["Enums"]["org_role"] }
        Returns: string[]
      }
      save_template_draft: {
        Args: {
          p_id: string
          p_layout: Json
          p_name: string
          p_org: string
          p_printer: string
          p_scope: Database["public"]["Enums"]["template_scope"]
          p_site: string
        }
        Returns: Json
      }
      set_printer_calibration: {
        Args: { p_org: string; p_printer: string; p_x: number; p_y: number }
        Returns: undefined
      }
      set_weight_unit: {
        Args: {
          p_org: string
          p_unit: Database["public"]["Enums"]["weight_unit"]
        }
        Returns: Json
      }
      upsert_party: {
        Args: {
          p_address?: string
          p_city?: string
          p_contact?: string
          p_email?: string
          p_gstin?: string
          p_id: string
          p_name: string
          p_org: string
          p_pan?: string
          p_phone?: string
          p_pin?: string
          p_state?: string
          p_type?: Database["public"]["Enums"]["party_type"]
        }
        Returns: Json
      }
      write_audit: {
        Args: {
          p_action: string
          p_actor: string
          p_entity_id: string
          p_entity_type: string
          p_meta?: Json
          p_org: string
          p_reason?: string
          p_site: string
        }
        Returns: undefined
      }
    }
    Enums: {
      agent_status: "active" | "revoked"
      invoice_status: "issued" | "cancelled"
      member_status: "active" | "disabled"
      org_role: "owner" | "admin" | "operator" | "accounts" | "remote_site"
      org_status: "trial" | "active" | "grace" | "suspended" | "archived"
      party_type: "debtor" | "vendor" | "both" | "customer"
      payment_mode: "cash" | "credit"
      platform_role: "super_admin" | "support"
      print_job_type: "original" | "reprint" | "test"
      print_status:
        | "not_configured"
        | "routing_error"
        | "queued"
        | "claimed"
        | "rendering"
        | "submitting"
        | "submitted_to_spooler"
        | "failed"
        | "unknown"
        | "cancelled"
      series_reset: "none" | "fiscal_year"
      template_scope: "tenant" | "site" | "printer"
      time_mode: "automatic" | "manual"
      weighment_status:
        | "pending_empty"
        | "ready_to_invoice"
        | "invoiced"
        | "voided"
      weight_unit: "kg" | "tonne"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      agent_status: ["active", "revoked"],
      invoice_status: ["issued", "cancelled"],
      member_status: ["active", "disabled"],
      org_role: ["owner", "admin", "operator", "accounts", "remote_site"],
      org_status: ["trial", "active", "grace", "suspended", "archived"],
      party_type: ["debtor", "vendor", "both", "customer"],
      payment_mode: ["cash", "credit"],
      platform_role: ["super_admin", "support"],
      print_job_type: ["original", "reprint", "test"],
      print_status: [
        "not_configured",
        "routing_error",
        "queued",
        "claimed",
        "rendering",
        "submitting",
        "submitted_to_spooler",
        "failed",
        "unknown",
        "cancelled",
      ],
      series_reset: ["none", "fiscal_year"],
      template_scope: ["tenant", "site", "printer"],
      time_mode: ["automatic", "manual"],
      weighment_status: [
        "pending_empty",
        "ready_to_invoice",
        "invoiced",
        "voided",
      ],
      weight_unit: ["kg", "tonne"],
    },
  },
} as const
