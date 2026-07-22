--
-- PostgreSQL database dump
--

\restrict ER8TELIk8so7GYpQGfn0qBEojhbo9fkldUUkBSTrpyjIkNVnIsh0XJwoaYv2V9R

-- Dumped from database version 16.10
-- Dumped by pg_dump version 16.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ercot_node_locations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ercot_node_locations (
    id integer NOT NULL,
    node_name text NOT NULL,
    node_type text NOT NULL,
    load_zone text,
    hub text,
    substation text,
    latitude numeric(8,5),
    longitude numeric(8,5),
    location_source text,
    eia_plant_name text,
    avg_da_price numeric(8,4),
    avg_rt_price numeric(8,4),
    months_available integer,
    created_at timestamp without time zone DEFAULT now()
);


ALTER TABLE public.ercot_node_locations OWNER TO postgres;

--
-- Name: ercot_node_locations_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.ercot_node_locations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.ercot_node_locations_id_seq OWNER TO postgres;

--
-- Name: ercot_node_locations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.ercot_node_locations_id_seq OWNED BY public.ercot_node_locations.id;


--
-- Name: ercot_node_locations id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ercot_node_locations ALTER COLUMN id SET DEFAULT nextval('public.ercot_node_locations_id_seq'::regclass);


--
-- Name: ercot_node_locations ercot_node_locations_node_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ercot_node_locations
    ADD CONSTRAINT ercot_node_locations_node_name_key UNIQUE (node_name);


--
-- Name: ercot_node_locations ercot_node_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ercot_node_locations
    ADD CONSTRAINT ercot_node_locations_pkey PRIMARY KEY (id);


--
-- Name: idx_enl_lat_lon; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enl_lat_lon ON public.ercot_node_locations USING btree (latitude, longitude);


--
-- Name: idx_enl_zone; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enl_zone ON public.ercot_node_locations USING btree (load_zone);


--
-- PostgreSQL database dump complete
--

\unrestrict ER8TELIk8so7GYpQGfn0qBEojhbo9fkldUUkBSTrpyjIkNVnIsh0XJwoaYv2V9R

