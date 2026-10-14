-- padding_width = 0 means "no padding". lpad(x, 0) returns '' (it truncates), which produced BLANK invoice numbers and then a duplicate-number conflict on the next entry.
do $$
declare d text;
begin
  select pg_get_functiondef('public.allocate_invoice_number(uuid, uuid, timestamptz)'::regprocedure) into d;
  d := replace(d, 'lpad(s.next_number::text, s.padding_width, ''0'')', '(case when s.padding_width > 0 then lpad(s.next_number::text, s.padding_width, ''0'') else s.next_number::text end)');
  if position('s.padding_width > 0' in d) = 0 then raise exception 'allocate_invoice_number patch did not apply'; end if;
  execute d;
end $$;

-- repair rows already issued with a blank number: use the sequence value the series gave them (only OPEN invoices can be touched; closed ones are immutable)
update public.invoices set invoice_number = seq_value::text where btrim(invoice_number) = '' and stage = 'open' and status = 'issued';

-- and never again: an invoice number can not be blank
alter table public.invoices add constraint invoice_number_not_blank check (char_length(btrim(invoice_number)) > 0);
